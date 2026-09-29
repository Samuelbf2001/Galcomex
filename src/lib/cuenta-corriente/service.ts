/**
 * Cuenta corriente por contraparte — capa de BD (M5)
 *
 * Arma los asientos de una empresa desde tres fuentes y los pasa al cálculo
 * puro (`./calculo.ts`):
 *
 *   1. Lado CLIENTE    — el saldo pendiente de cada factura de venta, tomado tal
 *                        cual del módulo de cartera para no divergir de él.
 *   2. Lado PROVEEDOR  — el SALDO de las facturas de proveedor Pendientes y
 *                        Abonadas (CxP v2: valor − pagado − ajustes − cruzado;
 *                        las Pagadas ya netean cero).
 *   3. Manuales        — `MovimientoCuenta`: la mensualidad de Coldex, las
 *                        comisiones de Eltrans, los ajustes.
 *
 * El puente hacia el lado proveedor es `Beneficiario.empresaId`; sin ese enlace
 * la empresa simplemente no tiene lado proveedor.
 *
 * Fase centavos: todo monto es CENTAVOS de COP; los mensajes a personas usan
 * `formatoPesos` y el AuditLog `normalizeSerializable` (pesos texto canónico).
 */

import {
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoMovimientoCuenta,
  type Prisma,
} from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import { eliminarPagoFactura, registrarPagoFacturaAbono } from "@/lib/cartera/service";
import { aplicarSaldo, bloquearFacturas, revertirSaldo } from "@/lib/cxp/aplicar";
import { bloquearTramites } from "@/lib/cxp/bloqueos";
import { saldoDe } from "@/lib/cxp/saldos";
import { TramiteCerradoError } from "@/lib/tramites/guard";
import { aFechaCalendario, formatFechaCalendario } from "@/lib/tiempo/bogota";
import {
  asientoDesde,
  calcularCuentaCorriente,
  maximoCompensable,
  type AsientoCuenta,
  type ResumenCuenta,
} from "@/lib/cuenta-corriente/calculo";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { formatoPesos } from "@/lib/dinero";

export class EmpresaCuentaNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaCuentaNoEncontradaError";
  }
}

export class CargosManualesNoHabilitadosError extends Error {
  public readonly status = 422;
  constructor(nombreEmpresa: string) {
    super(
      `${nombreEmpresa} no tiene habilitados los cargos manuales de contraparte. Actívalos en la ficha, pestaña Funciones.`,
    );
    this.name = "CargosManualesNoHabilitadosError";
  }
}

export class CuentaCorrienteNoHabilitadaError extends Error {
  public readonly status = 422;
  constructor(nombreEmpresa: string) {
    super(
      `${nombreEmpresa} no tiene habilitada la cuenta corriente. Actívala en la ficha, pestaña Funciones.`,
    );
    this.name = "CuentaCorrienteNoHabilitadaError";
  }
}

export class CompensacionInvalidaError extends Error {
  public readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "CompensacionInvalidaError";
  }
}

export class CompensacionNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Cruce ${id} no encontrado en esta empresa`);
    this.name = "CompensacionNoEncontradaError";
  }
}

export class FacturaProveedorDuplicadaError extends Error {
  public readonly status = 409;
  constructor(numeroFactura: string, nombreEmpresa: string, fecha: Date) {
    super(`Ya registraste la factura ${numeroFactura} de ${nombreEmpresa} el ${formatFechaCalendario(aFechaCalendario(fecha))}`);
    this.name = "FacturaProveedorDuplicadaError";
  }
}

/** Normaliza un N° de factura para detectar duplicados: mayúsculas, sin
 * espacios, puntos ni guiones ("FE-1234" y "fe 1234" son la misma factura). */
export function normalizarNumeroFactura(numeroFactura: string): string {
  return numeroFactura.trim().toUpperCase().replace(/[\s.\-]/g, "");
}

/**
 * Asientos del lado CLIENTE.
 *
 * `saldoNetoCliente` del módulo de cartera usa la convención contraria a la de
 * este módulo (allí negativo = el cliente debe), así que se invierte el signo
 * una sola vez, aquí. Las facturas saldadas no generan asiento.
 */
async function asientosComoCliente(
  empresaId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<AsientoCuenta[]> {
  const facturas = await db.factura.findMany({
    where: { clienteId: empresaId },
    select: {
      id: true,
      borradorId: true,
      numSiigo: true,
      fecha: true,
      saldoAFavorClienteCentavos: true,
      saldoACargoClienteCentavos: true,
      borrador: {
        select: {
          tramite: {
            select: {
              id: true,
              consecutivo: true,
              tipoTramite: { select: { lineaServicio: true } },
            },
          },
        },
      },
      pagos: {
        where: { destino: "CLIENTE" },
        select: { id: true, tipo: true, montoCentavos: true, fecha: true, compensacionId: true },
      },
    },
  });

  const asientos: AsientoCuenta[] = [];

  for (const factura of facturas) {
    const lineaServicio =
      factura.borrador?.tramite?.tipoTramite?.lineaServicio ?? "TRAMITE";
    const referencia = factura.borrador?.tramite?.consecutivo ?? factura.numSiigo;
    const tramiteId = factura.borrador?.tramite?.id ?? null;

    if (factura.saldoACargoClienteCentavos > 0n) {
      asientos.push(
        asientoDesde({
          id: `factura:${factura.id}`,
          fuente: "FACTURA_VENTA",
          rol: "CLIENTE",
          lineaServicio,
          concepto: `Factura ${factura.numSiigo}`,
          fecha: factura.fecha,
          valor: factura.saldoACargoClienteCentavos,
          referencia,
          tramiteId,
          facturaId: factura.id,
          borradorId: factura.borradorId,
        }),
      );
    }

    if (factura.saldoAFavorClienteCentavos > 0n) {
      // Sobró anticipo: la plata es del cliente hasta que se le devuelva.
      asientos.push({
        id: `factura-favor:${factura.id}`,
        fuente: "AJUSTE",
        rol: "CLIENTE",
        lineaServicio,
        concepto: `Saldo a favor del cliente · factura ${factura.numSiigo}`,
        fecha: factura.fecha,
        valor: -factura.saldoAFavorClienteCentavos,
        referencia,
        tramiteId,
        facturaId: factura.id,
        borradorId: factura.borradorId,
      });
    }

    for (const pago of factura.pagos) {
      asientos.push(
        asientoDesde({
          id: `pago-factura:${pago.id}`,
          fuente: pago.tipo === "ABONO" ? "ABONO_CLIENTE" : "DEVOLUCION_CLIENTE",
          rol: "CLIENTE",
          lineaServicio,
          concepto:
            pago.tipo === "ABONO"
              ? pago.compensacionId
                ? `Cruce · abono a factura ${factura.numSiigo}`
                : `Abono a factura ${factura.numSiigo}`
              : `Devolución sobre factura ${factura.numSiigo}`,
          fecha: pago.fecha,
          valor: pago.montoCentavos,
          referencia,
          tramiteId,
          compensacionId: pago.compensacionId,
        }),
      );
    }
  }

  return asientos;
}

/**
 * Saldo de una factura de proveedor leída con sus pagos/ajustes (CxP v2), en
 * centavos. Las consultas traen `pagos.montoCentavos` y `ajustes.montoCentavos`;
 * un doble en memoria sin esas relaciones cuenta 0.
 */
function saldoFacturaProveedor(f: {
  valorCentavos: bigint;
  montoCompensadoCentavos?: bigint | null;
  pagos?: { montoCentavos: bigint }[];
  ajustes?: { montoCentavos: bigint }[];
}): bigint {
  return saldoDe({
    valor: f.valorCentavos,
    aplicado: (f.pagos ?? []).reduce((s, p) => s + p.montoCentavos, 0n),
    ajustes: (f.ajustes ?? []).reduce((s, a) => s + a.montoCentavos, 0n),
    compensado: f.montoCompensadoCentavos ?? 0n,
  });
}

const ESTADOS_CON_SALDO = ["REGISTRADA", "PARCIAL"] as const;

/**
 * Asientos del lado PROVEEDOR: el saldo de las facturas que la empresa nos
 * emitió y que todavía no se han pagado del todo (Pendientes y Abonadas).
 * Incluye las marcadas como "no se le cobra al cliente" (M6): al proveedor se
 * le debe igual, se traslade o no.
 */
async function asientosComoProveedor(
  empresaId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<AsientoCuenta[]> {
  const beneficiarios = await db.beneficiario.findMany({
    where: { empresaId },
    select: { id: true },
  });

  if (beneficiarios.length === 0) {
    return [];
  }

  const facturas = await db.facturaProveedor.findMany({
    where: {
      beneficiarioId: { in: beneficiarios.map((b) => b.id) },
      estado: { in: [...ESTADOS_CON_SALDO] },
    },
    select: {
      id: true,
      numFactura: true,
      valorCentavos: true,
      montoCompensadoCentavos: true,
      fecha: true,
      repercutible: true,
      pagos: { select: { montoCentavos: true } },
      ajustes: { select: { montoCentavos: true } },
      tramite: {
        select: {
          id: true,
          consecutivo: true,
          tipoTramite: { select: { lineaServicio: true } },
        },
      },
    },
  });

  return facturas
    .map((factura) => ({ factura, saldo: saldoFacturaProveedor(factura) }))
    .filter(({ saldo }) => saldo > 0n)
    .map(({ factura, saldo }) =>
      asientoDesde({
        id: `factura-proveedor:${factura.id}`,
        fuente: "FACTURA_PROVEEDOR",
        rol: "PROVEEDOR",
        lineaServicio: factura.repercutible
          ? (factura.tramite.tipoTramite?.lineaServicio ?? "TRAMITE")
          : "ASESORIA",
        concepto: `Factura de proveedor ${factura.numFactura}${
          saldo < factura.valorCentavos ? ` · abonada (saldo de ${formatoPesos(factura.valorCentavos)})` : ""
        }${factura.repercutible ? "" : " · no se le cobra al cliente"}`,
        fecha: factura.fecha,
        valor: saldo,
        referencia: factura.tramite.consecutivo,
        tramiteId: factura.tramite.id,
      }),
    );
}

/** Asientos registrados a mano. El signo lo da `tipo`, no la fuente. */
async function asientosManuales(
  empresaId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<AsientoCuenta[]> {
  const movimientos = await db.movimientoCuenta.findMany({
    where: { empresaId },
    select: {
      id: true,
      rol: true,
      tipo: true,
      origen: true,
      lineaServicio: true,
      concepto: true,
      valorCentavos: true,
      fecha: true,
      compensacionId: true,
      numeroFactura: true,
      soporteKey: true,
      tramite: { select: { id: true, consecutivo: true } },
    },
  });

  return movimientos.map((movimiento) => ({
    id: `movimiento:${movimiento.id}`,
    rol: movimiento.rol,
    numeroFactura: movimiento.numeroFactura,
    tieneSoporte: Boolean(movimiento.soporteKey),
    fuente:
      movimiento.origen === OrigenMovimientoCuenta.COMISION
        ? ("COMISION" as const)
        : movimiento.origen === OrigenMovimientoCuenta.CARGO_MANUAL
          ? ("CARGO_MANUAL" as const)
          : movimiento.origen === OrigenMovimientoCuenta.COMPENSACION
            ? ("COMPENSACION" as const)
            : ("AJUSTE" as const),
    lineaServicio: movimiento.lineaServicio,
    concepto: movimiento.concepto,
    fecha: movimiento.fecha,
    valor:
      movimiento.tipo === TipoMovimientoCuenta.CARGO
        ? movimiento.valorCentavos
        : -movimiento.valorCentavos,
    referencia: movimiento.tramite?.consecutivo ?? null,
    tramiteId: movimiento.tramite?.id ?? null,
    compensacionId: movimiento.compensacionId,
  }));
}

/** Documentos contra los que se puede cruzar hoy. */
export interface CompensablesEmpresa {
  facturasVenta: { id: string; numSiigo: string; referencia: string | null; pendiente: bigint }[];
  /**
   * Facturas de proveedor no repercutibles con saldo. `valor` = su SALDO (CxP
   * v2): una factura Abonada se cruza por lo que le falta, no por su total.
   */
  facturasProveedor: { id: string; numFactura: string; referencia: string; valor: bigint }[];
}

async function compensablesDe(
  empresaId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<CompensablesEmpresa> {
  const [facturas, beneficiarios] = await Promise.all([
    db.factura.findMany({
      where: { clienteId: empresaId },
      select: {
        id: true,
        numSiigo: true,
        saldoAFavorClienteCentavos: true,
        saldoACargoClienteCentavos: true,
        borrador: { select: { tramite: { select: { consecutivo: true } } } },
        pagos: { where: { destino: "CLIENTE" }, select: { tipo: true, montoCentavos: true } },
      },
    }),
    db.beneficiario.findMany({ where: { empresaId }, select: { id: true } }),
  ]);

  const facturasVenta = facturas
    .map((f) => {
      const abonos = f.pagos.filter((p) => p.tipo === "ABONO").reduce((s, p) => s + p.montoCentavos, 0n);
      const devoluciones = f.pagos.filter((p) => p.tipo === "DEVOLUCION").reduce((s, p) => s + p.montoCentavos, 0n);
      // Misma fórmula que cartera: negativo = el cliente debe.
      const saldoNeto = f.saldoAFavorClienteCentavos - f.saldoACargoClienteCentavos + abonos - devoluciones;
      return {
        id: f.id,
        numSiigo: f.numSiigo,
        referencia: f.borrador?.tramite?.consecutivo ?? null,
        pendiente: saldoNeto < 0n ? -saldoNeto : 0n,
      };
    })
    .filter((f) => f.pendiente > 0n);

  const facturasProveedor =
    beneficiarios.length === 0
      ? []
      : (
          await db.facturaProveedor.findMany({
            where: {
              beneficiarioId: { in: beneficiarios.map((b) => b.id) },
              estado: { in: [...ESTADOS_CON_SALDO] },
              repercutible: false,
              // Una factura, un cruce (ver registrarCompensacionBajoLock).
              compensacionId: null,
              montoCompensadoCentavos: 0n,
            },
            select: {
              id: true,
              numFactura: true,
              valorCentavos: true,
              montoCompensadoCentavos: true,
              pagos: { select: { montoCentavos: true } },
              ajustes: { select: { montoCentavos: true } },
              tramite: { select: { consecutivo: true } },
            },
            orderBy: { fecha: "asc" },
          })
        )
          .map((f) => ({
            id: f.id,
            numFactura: f.numFactura,
            referencia: f.tramite.consecutivo,
            valor: saldoFacturaProveedor(f),
          }))
          .filter((f) => f.valor > 0n);

  return { facturasVenta, facturasProveedor };
}

export interface CuentaCorrienteEmpresa extends ResumenCuenta {
  empresa: {
    id: string;
    nombre: string;
    nit: string;
    esCliente: boolean;
    esProveedor: boolean;
  };
  /**
   * `true` si la empresa tiene la función `cuenta_corriente`. Apagada, la ficha
   * no muestra la sección y no se registran movimientos ni cruces; el saldo se
   * sigue calculando para quien lo consulte (MCP, reportes).
   */
  habilitada: boolean;
  /** `true` si la ficha puede registrar cargos manuales (capacidad M1). */
  permiteCargosManuales: boolean;
  /** `true` si está encendida `cuenta_corriente` (ajustes y comisiones a mano). */
  cuentaCorrienteActiva: boolean;
  /** Cuánto se puede cruzar hoy (la punta menor). */
  maximoCompensable: bigint;
  compensables: CompensablesEmpresa;
}

/** `db` = la transacción cuando se consulta para validar un cruce bajo lock. */
export async function getCuentaCorriente(
  empresaId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<CuentaCorrienteEmpresa> {
  const empresa = await db.cliente.findUnique({
    where: { id: empresaId },
    select: { id: true, nombre: true, nit: true, esCliente: true, esProveedor: true },
  });

  if (!empresa) {
    throw new EmpresaCuentaNoEncontradaError(empresaId);
  }

  const [comoCliente, comoProveedor, manuales, capacidades, compensables] = await Promise.all([
    asientosComoCliente(empresaId, db),
    asientosComoProveedor(empresaId, db),
    asientosManuales(empresaId, db),
    capacidadesDeEmpresa(empresaId),
    compensablesDe(empresaId, db),
  ]);

  const resumen = calcularCuentaCorriente([
    ...comoCliente,
    ...comoProveedor,
    ...manuales,
  ]);

  return {
    ...resumen,
    empresa,
    // El bloque se muestra con cualquiera de las dos: una empresa que solo
    // registra facturas por fuera de trámites (Coldex) no necesita encender
    // la cuenta cruzada completa para ver su sección.
    habilitada:
      tiene(capacidades, "cuenta_corriente") || tiene(capacidades, "cargos_manuales_contraparte"),
    permiteCargosManuales: tiene(capacidades, "cargos_manuales_contraparte"),
    cuentaCorrienteActiva: tiene(capacidades, "cuenta_corriente"),
    maximoCompensable: maximoCompensable(resumen),
    compensables,
  };
}

export interface RegistrarMovimientoInput {
  empresaId: string;
  rol: RolCuenta;
  tipo: TipoMovimientoCuenta;
  origen: OrigenMovimientoCuenta;
  lineaServicio?: string;
  concepto: string;
  /** Centavos de COP. */
  valor: bigint;
  fecha: Date;
  tramiteId?: string | null;
  usuarioId: string;
  /** N° de la factura del proveedor ("Registrar factura de <proveedor>"). */
  numeroFactura?: string | null;
  /** PDF de soporte ya subido a la bodega (`POST …/cuenta/soporte`). */
  soporte?: { key: string; nombre: string; mime: string } | null;
}

/**
 * Registra un movimiento manual (mensualidad de Coldex, comisión de Eltrans,
 * ajuste). "Registrar factura" (`CARGO_MANUAL`) exige solo la capacidad
 * `cargos_manuales_contraparte` — no `cuenta_corriente` — para que una empresa
 * que nunca es proveedora pueda usarlo sin encender la cuenta cruzada
 * completa. El resto de orígenes (otro ajuste, comisión) sigue exigiendo
 * `cuenta_corriente`, igual que "Cruzar saldos".
 *
 * Si trae `numeroFactura`, rechaza (409) un segundo registro de la misma
 * empresa + rol con el mismo N° de factura (normalizado) que no sea una
 * compensación — evita que "Registrar factura" se dispare dos veces por
 * descuido con la misma factura.
 */
export async function registrarMovimientoCuenta(input: RegistrarMovimientoInput) {
  const empresa = await prisma.cliente.findUnique({
    where: { id: input.empresaId },
    select: { id: true, nombre: true },
  });

  if (!empresa) {
    throw new EmpresaCuentaNoEncontradaError(input.empresaId);
  }

  const capacidades = await capacidadesDeEmpresa(input.empresaId);

  if (input.origen === OrigenMovimientoCuenta.CARGO_MANUAL) {
    if (!tiene(capacidades, "cargos_manuales_contraparte")) {
      throw new CargosManualesNoHabilitadosError(empresa.nombre);
    }
  } else if (!tiene(capacidades, "cuenta_corriente")) {
    throw new CuentaCorrienteNoHabilitadaError(empresa.nombre);
  }

  const numeroFactura = input.numeroFactura?.trim() || null;
  const numeroFacturaNorm = numeroFactura ? normalizarNumeroFactura(numeroFactura) : null;

  if (numeroFacturaNorm) {
    const duplicado = await prisma.movimientoCuenta.findFirst({
      where: {
        empresaId: input.empresaId,
        rol: input.rol,
        numeroFacturaNorm,
        origen: { not: OrigenMovimientoCuenta.COMPENSACION },
      },
      select: { fecha: true, numeroFactura: true },
      orderBy: { fecha: "desc" },
    });
    if (duplicado) {
      // El mensaje muestra el número tal como quedó guardado la primera vez,
      // no el que tecleó el usuario ahora (puede venir con formato distinto:
      // "fe.0001" vs "FE-0001", y confunde si se le devuelve tal cual).
      throw new FacturaProveedorDuplicadaError(
        duplicado.numeroFactura ?? numeroFactura!,
        empresa.nombre,
        duplicado.fecha,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const movimiento = await tx.movimientoCuenta.create({
      data: {
        empresaId: input.empresaId,
        rol: input.rol,
        tipo: input.tipo,
        origen: input.origen,
        lineaServicio: input.lineaServicio ?? "TRAMITE",
        concepto: input.concepto,
        // El signo lo lleva `tipo`: en BD el valor siempre es positivo.
        valorCentavos: input.valor < 0n ? -input.valor : input.valor,
        fecha: input.fecha,
        tramiteId: input.tramiteId ?? null,
        registradoPorId: input.usuarioId,
        numeroFactura,
        numeroFacturaNorm,
        soporteKey: input.soporte?.key ?? null,
        soporteNombre: input.soporte?.nombre ?? null,
        soporteMime: input.soporte?.mime ?? null,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "MovimientoCuenta",
        entidadId: movimiento.id,
        accion: "CREATE_MOVIMIENTO_CUENTA",
        usuarioId: input.usuarioId,
        tramiteId: input.tramiteId ?? undefined,
        despues: normalizeSerializable(movimiento),
      },
    });

    return movimiento;
  });
}

export async function eliminarMovimientoCuenta(
  movimientoId: string,
  usuarioId: string,
) {
  return prisma.$transaction(async (tx) => {
    const movimiento = await tx.movimientoCuenta.findUnique({
      where: { id: movimientoId },
    });

    if (!movimiento) {
      throw new EmpresaCuentaNoEncontradaError(movimientoId);
    }

    await tx.movimientoCuenta.delete({ where: { id: movimientoId } });

    await tx.auditLog.create({
      data: {
        entidad: "MovimientoCuenta",
        entidadId: movimientoId,
        accion: "DELETE_MOVIMIENTO_CUENTA",
        usuarioId,
        antes: normalizeSerializable(movimiento),
      },
    });

    return movimiento;
  });
}

// ─── Cruce de saldos (compensación) ───────────────────────────────────────────

export interface RegistrarCompensacionInput {
  empresaId: string;
  valor?: bigint;
  fecha: Date;
  concepto: string;
  lineaServicio?: string;
  facturaId?: string | null;
  facturaProveedorId?: string | null;
  usuarioId: string;
}

/**
 * Salda el mismo importe en las dos puntas sin que se mueva plata — lo que
 * Camila hace hoy a mano con Coldex ("meto esa factura y la cruzo con lo que
 * ellos nos deben, para no hacer doble transferencia").
 *
 * Cada punta se registra donde su módulo la lee, para que cartera, el trámite
 * y la cuenta corriente cuenten lo mismo:
 *   · Punta cliente: abono (sin canal, costo 0) a la factura de venta elegida,
 *     o un ABONO manual con origen COMPENSACION.
 *   · Punta proveedor: la factura de proveedor elegida se salda por su SALDO
 *     con `aplicarSaldo` (CxP v2: una Abonada se cruza por lo que le falta;
 *     solo no repercutibles: las que se cobran al cliente necesitan el pago
 *     real del libro), o un CARGO manual con origen COMPENSACION.
 * El neto de la cuenta no cambia; bajan las dos puntas.
 *
 * Concurrencia: la validación va DENTRO de la transacción, bajo un advisory
 * lock por empresa (`cuenta_corriente:<empresaId>`) y, si hay factura de venta,
 * el mismo lock de abonos de cartera (`pago_factura:<id>:CLIENTE`); la factura
 * de proveedor se bloquea (DO y luego factura, `FOR UPDATE`) antes de validar
 * y `aplicarSaldo` vuelve a comprobar su saldo (más el guardián de BD). Así
 * dos cruces, o un cruce y un pago simultáneos, no saldan dos veces lo mismo.
 */
export async function registrarCompensacion(input: RegistrarCompensacionInput) {
  const lockCuenta = `cuenta_corriente:${input.empresaId}`;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockCuenta}))`;
      if (input.facturaId) {
        // Misma clave que registrarPagoFacturaAbono (lib/cartera): ningún abono
        // a esa factura entra entre esta validación y el abono del cruce.
        const lockAbonos = `pago_factura:${input.facturaId}:CLIENTE`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockAbonos}))`;
      }
      return registrarCompensacionBajoLock(tx, input);
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}

/** DO de la factura y luego la factura, `FOR UPDATE` (orden único de CxP v2). */
async function bloquearFacturaParaCruce(tx: Prisma.TransactionClient, facturaProveedorId: string) {
  const previa = await tx.facturaProveedor.findUnique({
    where: { id: facturaProveedorId },
    select: { tramiteId: true },
  });
  if (previa) await bloquearTramites(tx, [previa.tramiteId]);
  return bloquearFacturas(tx, [facturaProveedorId]);
}

async function registrarCompensacionBajoLock(
  tx: Prisma.TransactionClient,
  input: RegistrarCompensacionInput,
) {
  const empresa = await tx.cliente.findUnique({
    where: { id: input.empresaId },
    select: { id: true, nombre: true },
  });
  if (!empresa) throw new EmpresaCuentaNoEncontradaError(input.empresaId);

  // CxP v2 (§B.5): la factura de proveedor se bloquea (DO → factura) ANTES de
  // leer su saldo, para que ningún pago la salde entre la validación y el cruce.
  const bloqueadas = input.facturaProveedorId
    ? await bloquearFacturaParaCruce(tx, input.facturaProveedorId)
    : null;

  // Una factura, un cruce: la factura guarda UN `compensacionId` y un
  // `montoCompensado` total. Con dos cruces, deshacer uno dejaba la punta
  // proveedor mal (se perdía el otro o quedaba saldada con plata que ya no
  // existe). Si le falta saldo después de un cruce, se paga por el libro o se
  // deshace el cruce y se vuelve a cruzar por el total.
  const yaCruzada = input.facturaProveedorId ? bloqueadas?.get(input.facturaProveedorId) : undefined;
  if (yaCruzada && (yaCruzada.compensacionId !== null || yaCruzada.compensado > 0n)) {
    throw new CompensacionInvalidaError(
      `La factura ${yaCruzada.numFactura} ya tiene un cruce de cuenta. Deshaz ese cruce antes de cruzarla otra vez, o paga lo que le falta por el libro de pagos.`,
    );
  }

  const cuenta = await getCuentaCorriente(input.empresaId, tx);
  if (!cuenta.habilitada) throw new CuentaCorrienteNoHabilitadaError(empresa.nombre);

  // Punta proveedor: el saldo de la factura fija el valor.
  let facturaProveedor: { id: string; numFactura: string; valor: bigint } | null = null;
  if (input.facturaProveedorId) {
    const fp = cuenta.compensables.facturasProveedor.find((f) => f.id === input.facturaProveedorId);
    if (!fp) {
      throw new CompensacionInvalidaError(
        "La factura de proveedor no está pendiente, no es de esta empresa o se le cobra al cliente (esas se pagan por el libro de pagos).",
      );
    }
    facturaProveedor = fp;
    if (input.valor !== undefined && input.valor !== fp.valor) {
      throw new CompensacionInvalidaError(
        `Al cruzar una factura de proveedor el valor es lo que le falta por pagar: ${formatoPesos(fp.valor)}.`,
      );
    }
  }

  const valor = facturaProveedor ? facturaProveedor.valor : (input.valor ?? 0n);
  if (valor <= 0n) throw new CompensacionInvalidaError("El valor debe ser mayor a 0.");
  if (valor > cuenta.maximoCompensable) {
    throw new CompensacionInvalidaError(
      `Solo se pueden cruzar hasta ${formatoPesos(cuenta.maximoCompensable)}: pendiente nos deben ${formatoPesos(cuenta.pendienteCliente)} y les debemos ${formatoPesos(cuenta.pendienteProveedor)}.`,
    );
  }

  // Punta cliente: la factura de venta debe tener ese pendiente.
  let facturaVenta: { id: string; numSiigo: string; pendiente: bigint } | null = null;
  if (input.facturaId) {
    const fv = cuenta.compensables.facturasVenta.find((f) => f.id === input.facturaId);
    if (!fv) throw new CompensacionInvalidaError("La factura de venta no tiene saldo pendiente o no es de esta empresa.");
    if (valor > fv.pendiente) {
      throw new CompensacionInvalidaError(
        `La factura ${fv.numSiigo} solo tiene pendientes ${formatoPesos(fv.pendiente)}.`,
      );
    }
    facturaVenta = fv;
  }

  const lineaServicio = input.lineaServicio ?? "TRAMITE";

  const compensacionId = (
    await tx.auditLog.create({
      data: {
        entidad: "Cliente",
        entidadId: input.empresaId,
        accion: "COMPENSACION",
        usuarioId: input.usuarioId,
        despues: normalizeSerializable({
          valor,
          fecha: input.fecha,
          concepto: input.concepto,
          lineaServicio,
          facturaId: facturaVenta?.id ?? null,
          facturaProveedorId: facturaProveedor?.id ?? null,
        }),
      },
      select: { id: true },
    })
  ).id;

  // Punta cliente
  if (facturaVenta) {
    const abono = await registrarPagoFacturaAbono({
      facturaId: facturaVenta.id,
      destino: "CLIENTE",
      tipo: "ABONO",
      monto: valor,
      fecha: input.fecha,
      compensacionId,
      tx,
      usuarioId: input.usuarioId,
    });
    if (!abono.ok) throw new CompensacionInvalidaError(abono.message);
  } else {
    await tx.movimientoCuenta.create({
      data: {
        empresaId: input.empresaId,
        rol: RolCuenta.CLIENTE,
        tipo: TipoMovimientoCuenta.ABONO,
        origen: OrigenMovimientoCuenta.COMPENSACION,
        lineaServicio,
        concepto: `Cruce · ${input.concepto}`,
        valorCentavos: valor,
        fecha: input.fecha,
        registradoPorId: input.usuarioId,
        compensacionId,
      },
    });
  }

  // Punta proveedor
  if (facturaProveedor && bloqueadas) {
    // Única puerta de saldo (CxP v2): vuelve a validar el saldo con la fila
    // bloqueada; si el libro de pagos u otro cruce la saldó en medio, falla y
    // el throw deshace el abono de arriba.
    const { cambios } = await aplicarSaldo(tx, {
      origen: { tipo: "COMPENSACION", compensacionId },
      aplicaciones: [{ facturaProveedorId: facturaProveedor.id, monto: valor }],
      facturas: bloqueadas,
      modo: "COMPENSACION",
      usuarioId: input.usuarioId,
    });
    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaProveedor.id,
        accion: "PAGADA_POR_COMPENSACION",
        usuarioId: input.usuarioId,
        antes: normalizeSerializable({ estado: cambios[0]?.estadoAntes, saldo: cambios[0]?.saldoAntes }),
        despues: normalizeSerializable({ estado: cambios[0]?.estadoDespues, compensacionId, monto: valor }),
      },
    });
  } else {
    await tx.movimientoCuenta.create({
      data: {
        empresaId: input.empresaId,
        rol: RolCuenta.PROVEEDOR,
        tipo: TipoMovimientoCuenta.CARGO,
        origen: OrigenMovimientoCuenta.COMPENSACION,
        lineaServicio,
        concepto: `Cruce · ${input.concepto}`,
        valorCentavos: valor,
        fecha: input.fecha,
        registradoPorId: input.usuarioId,
        compensacionId,
      },
    });
  }

  return { compensacionId, valor };
}

/**
 * Deshace un cruce: retira sus dos puntas y le devuelve a la factura de
 * proveedor lo cruzado con `revertirSaldo` (queda Pendiente o Abonada según lo
 * que tenga pagado; CxP v2). Un DO cerrado no se toca (R10).
 */
export async function eliminarCompensacion(empresaId: string, compensacionId: string, usuarioId: string) {
  return prisma.$transaction(async (tx) => {
    // Mismo orden de bloqueo que registrarCompensacion (§B.5): cuenta de la
    // empresa → abonos de cada factura de venta del cruce → DOs → facturas.
    // Al revés (DO primero), deshacer un cruce mientras otro registra uno nuevo
    // sobre la misma factura de venta y el mismo DO terminaba en deadlock.
    const lockCuenta = `cuenta_corriente:${empresaId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockCuenta}))`;

    const [movimientos, pagos, facturasProveedor] = await Promise.all([
      tx.movimientoCuenta.findMany({ where: { compensacionId, empresaId } }),
      tx.pagoFactura.findMany({
        where: { compensacionId, factura: { clienteId: empresaId } },
        select: { id: true, facturaId: true },
      }),
      tx.facturaProveedor.findMany({
        where: { compensacionId, beneficiario: { empresaId } },
        select: { id: true, tramiteId: true },
      }),
    ]);
    if (movimientos.length === 0 && pagos.length === 0 && facturasProveedor.length === 0) {
      throw new CompensacionNoEncontradaError(compensacionId);
    }

    for (const facturaVentaId of [...new Set(pagos.map((p) => p.facturaId))].sort()) {
      const lockAbonos = `pago_factura:${facturaVentaId}:CLIENTE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockAbonos}))`;
    }

    if (facturasProveedor.length > 0) {
      const tramiteIds = facturasProveedor.map((f) => f.tramiteId);
      await bloquearTramites(tx, tramiteIds);
      const tramites = await tx.tramiteDO.findMany({
        where: { id: { in: tramiteIds } },
        select: { id: true, consecutivo: true, estado: true },
      });
      const cerrado = tramites.find((t) => t.estado === "CERRADO");
      if (cerrado) throw new TramiteCerradoError(cerrado);
    }

    for (const m of movimientos) await tx.movimientoCuenta.delete({ where: { id: m.id } });
    for (const p of pagos) {
      const r = await eliminarPagoFactura(p.id, usuarioId, tx);
      if (!r.ok) throw new CompensacionInvalidaError(r.message);
    }
    if (facturasProveedor.length > 0) {
      await revertirSaldo(tx, { tipo: "COMPENSACION", compensacionId }, usuarioId, "Cruce deshecho");
    }

    await tx.auditLog.create({
      data: {
        entidad: "Cliente",
        entidadId: empresaId,
        accion: "DESHACER_COMPENSACION",
        usuarioId,
        antes: normalizeSerializable({ compensacionId, movimientos: movimientos.length, abonos: pagos.length, facturasProveedor: facturasProveedor.length }),
      },
    });

    return { compensacionId };
  });
}
