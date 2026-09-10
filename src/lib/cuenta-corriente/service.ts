/**
 * Cuenta corriente por contraparte — capa de BD (M5)
 *
 * Arma los asientos de una empresa desde tres fuentes y los pasa al cálculo
 * puro (`./calculo.ts`):
 *
 *   1. Lado CLIENTE    — el saldo pendiente de cada factura de venta, tomado tal
 *                        cual del módulo de cartera para no divergir de él.
 *   2. Lado PROVEEDOR  — las facturas de proveedor todavía en REGISTRADA
 *                        (las PAGADAS ya están saldadas y netean cero).
 *   3. Manuales        — `MovimientoCuenta`: la mensualidad de Coldex, las
 *                        comisiones de Eltrans, los ajustes.
 *
 * El puente hacia el lado proveedor es `Beneficiario.empresaId`; sin ese enlace
 * la empresa simplemente no tiene lado proveedor.
 */

import {
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoMovimientoCuenta,
  type Prisma,
} from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import {
  asientoDesde,
  calcularCuentaCorriente,
  type AsientoCuenta,
  type ResumenCuenta,
} from "@/lib/cuenta-corriente/calculo";
import { prisma } from "@/lib/db/prisma";

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

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/**
 * Asientos del lado CLIENTE.
 *
 * `saldoNetoCliente` del módulo de cartera usa la convención contraria a la de
 * este módulo (allí negativo = el cliente debe), así que se invierte el signo
 * una sola vez, aquí. Las facturas saldadas no generan asiento.
 */
async function asientosComoCliente(empresaId: string): Promise<AsientoCuenta[]> {
  const facturas = await prisma.factura.findMany({
    where: { clienteId: empresaId },
    select: {
      id: true,
      numSiigo: true,
      fecha: true,
      saldoAFavorCliente: true,
      saldoACargoCliente: true,
      borrador: {
        select: {
          tramite: {
            select: {
              consecutivo: true,
              tipoTramite: { select: { lineaServicio: true } },
            },
          },
        },
      },
      pagos: {
        where: { destino: "CLIENTE" },
        select: { id: true, tipo: true, monto: true, fecha: true },
      },
    },
  });

  const asientos: AsientoCuenta[] = [];

  for (const factura of facturas) {
    const lineaServicio =
      factura.borrador?.tramite?.tipoTramite?.lineaServicio ?? "TRAMITE";
    const referencia = factura.borrador?.tramite?.consecutivo ?? factura.numSiigo;

    if (factura.saldoACargoCliente > 0n) {
      asientos.push(
        asientoDesde({
          id: `factura:${factura.id}`,
          fuente: "FACTURA_VENTA",
          lineaServicio,
          concepto: `Factura ${factura.numSiigo}`,
          fecha: factura.fecha,
          valor: factura.saldoACargoCliente,
          referencia,
        }),
      );
    }

    if (factura.saldoAFavorCliente > 0n) {
      // Sobró anticipo: la plata es del cliente hasta que se le devuelva.
      asientos.push({
        id: `factura-favor:${factura.id}`,
        fuente: "AJUSTE",
        lineaServicio,
        concepto: `Saldo a favor del cliente · factura ${factura.numSiigo}`,
        fecha: factura.fecha,
        valor: -factura.saldoAFavorCliente,
        referencia,
      });
    }

    for (const pago of factura.pagos) {
      asientos.push(
        asientoDesde({
          id: `pago-factura:${pago.id}`,
          fuente: pago.tipo === "ABONO" ? "ABONO_CLIENTE" : "DEVOLUCION_CLIENTE",
          lineaServicio,
          concepto:
            pago.tipo === "ABONO"
              ? `Abono a factura ${factura.numSiigo}`
              : `Devolución sobre factura ${factura.numSiigo}`,
          fecha: pago.fecha,
          valor: pago.monto,
          referencia,
        }),
      );
    }
  }

  return asientos;
}

/**
 * Asientos del lado PROVEEDOR: facturas que la empresa nos emitió y que todavía
 * no se han pagado. Incluye las marcadas como "no se le cobra al cliente" (M6):
 * al proveedor se le debe igual, se traslade o no.
 */
async function asientosComoProveedor(empresaId: string): Promise<AsientoCuenta[]> {
  const beneficiarios = await prisma.beneficiario.findMany({
    where: { empresaId },
    select: { id: true },
  });

  if (beneficiarios.length === 0) {
    return [];
  }

  const facturas = await prisma.facturaProveedor.findMany({
    where: {
      beneficiarioId: { in: beneficiarios.map((b) => b.id) },
      estado: "REGISTRADA",
    },
    select: {
      id: true,
      numFactura: true,
      valor: true,
      fecha: true,
      repercutible: true,
      tramite: {
        select: {
          consecutivo: true,
          tipoTramite: { select: { lineaServicio: true } },
        },
      },
    },
  });

  return facturas.map((factura) =>
    asientoDesde({
      id: `factura-proveedor:${factura.id}`,
      fuente: "FACTURA_PROVEEDOR",
      lineaServicio: factura.repercutible
        ? (factura.tramite.tipoTramite?.lineaServicio ?? "TRAMITE")
        : "ASESORIA",
      concepto: `Factura de proveedor ${factura.numFactura}${
        factura.repercutible ? "" : " · no se le cobra al cliente"
      }`,
      fecha: factura.fecha,
      valor: factura.valor,
      referencia: factura.tramite.consecutivo,
    }),
  );
}

/** Asientos registrados a mano. El signo lo da `tipo`, no la fuente. */
async function asientosManuales(empresaId: string): Promise<AsientoCuenta[]> {
  const movimientos = await prisma.movimientoCuenta.findMany({
    where: { empresaId },
    select: {
      id: true,
      tipo: true,
      origen: true,
      lineaServicio: true,
      concepto: true,
      valor: true,
      fecha: true,
      tramite: { select: { consecutivo: true } },
    },
  });

  return movimientos.map((movimiento) => ({
    id: `movimiento:${movimiento.id}`,
    fuente:
      movimiento.origen === OrigenMovimientoCuenta.COMISION
        ? ("COMISION" as const)
        : movimiento.origen === OrigenMovimientoCuenta.CARGO_MANUAL
          ? ("CARGO_MANUAL" as const)
          : ("AJUSTE" as const),
    lineaServicio: movimiento.lineaServicio,
    concepto: movimiento.concepto,
    fecha: movimiento.fecha,
    valor:
      movimiento.tipo === TipoMovimientoCuenta.CARGO
        ? movimiento.valor
        : -movimiento.valor,
    referencia: movimiento.tramite?.consecutivo ?? null,
  }));
}

export interface CuentaCorrienteEmpresa extends ResumenCuenta {
  empresa: {
    id: string;
    nombre: string;
    nit: string;
    esCliente: boolean;
    esProveedor: boolean;
  };
  /** `true` si la ficha puede registrar cargos manuales (capacidad M1). */
  permiteCargosManuales: boolean;
}

export async function getCuentaCorriente(
  empresaId: string,
): Promise<CuentaCorrienteEmpresa> {
  const empresa = await prisma.cliente.findUnique({
    where: { id: empresaId },
    select: { id: true, nombre: true, nit: true, esCliente: true, esProveedor: true },
  });

  if (!empresa) {
    throw new EmpresaCuentaNoEncontradaError(empresaId);
  }

  const [comoCliente, comoProveedor, manuales, capacidades] = await Promise.all([
    asientosComoCliente(empresaId),
    asientosComoProveedor(empresaId),
    asientosManuales(empresaId),
    capacidadesDeEmpresa(empresaId),
  ]);

  const resumen = calcularCuentaCorriente([
    ...comoCliente,
    ...comoProveedor,
    ...manuales,
  ]);

  return {
    ...resumen,
    empresa,
    permiteCargosManuales: tiene(capacidades, "cargos_manuales_contraparte"),
  };
}

export interface RegistrarMovimientoInput {
  empresaId: string;
  rol: RolCuenta;
  tipo: TipoMovimientoCuenta;
  origen: OrigenMovimientoCuenta;
  lineaServicio?: string;
  concepto: string;
  valor: bigint;
  fecha: Date;
  tramiteId?: string | null;
  usuarioId: string;
}

/**
 * Registra un movimiento manual (mensualidad de Coldex, comisión de Eltrans,
 * ajuste). Los cargos manuales exigen la capacidad `cargos_manuales_contraparte`
 * — un importe que no nace de un trámite no debería poder aparecer en la cuenta
 * de cualquier empresa por descuido.
 */
export async function registrarMovimientoCuenta(input: RegistrarMovimientoInput) {
  const empresa = await prisma.cliente.findUnique({
    where: { id: input.empresaId },
    select: { id: true, nombre: true },
  });

  if (!empresa) {
    throw new EmpresaCuentaNoEncontradaError(input.empresaId);
  }

  if (input.origen === OrigenMovimientoCuenta.CARGO_MANUAL) {
    const capacidades = await capacidadesDeEmpresa(input.empresaId);

    if (!tiene(capacidades, "cargos_manuales_contraparte")) {
      throw new CargosManualesNoHabilitadosError(empresa.nombre);
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
        valor: input.valor < 0n ? -input.valor : input.valor,
        fecha: input.fecha,
        tramiteId: input.tramiteId ?? null,
        registradoPorId: input.usuarioId,
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
