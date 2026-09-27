/**
 * Servicio de facturas de proveedor — Galcomex
 * WS-A: entidad FacturaProveedor + integración con PagoTramite.
 *
 * Flujo:
 * 1. Se registra la factura que el proveedor le emite a Galcomex, SIEMPRE con
 *    su ficha de pago (`beneficiarioId`, R7): de la ficha salen el nombre, el
 *    NIT y la llave anti-duplicado.
 * 2. Se paga (pago del DO, pago en bloque, "generar pago" o cruce): eso lo
 *    maneja el dominio de pagos (P1) con saldos por monto.
 * 3. Cuando el DO está listo, solicita facturación → DO pasa a ENVIADO_A_FACTURAR.
 *
 * CxP v2 (docs/CXP-PROVEEDORES.md, diseño §C R7, R10–R12, R14, R17):
 *  - Llave única: proveedor (NIT base de la ficha, o la ficha si no tiene NIT
 *    colombiano) + número normalizado ("FE- 12481" = "FE12481"). La calcula un
 *    trigger de BD y la respalda un índice único; aquí se valida antes para
 *    dar el mensaje claro (`FACTURA_DUPLICADA`) y se traduce el P2002 si dos
 *    altas simultáneas se cruzan. Mismos dígitos con otro texto → aviso
 *    `POSIBLE_DUPLICADO` que se confirma.
 *  - Editar: con pagos/ajustes/cruce no cambian valor, proveedor, número,
 *    moneda/TRM ni "se cobra al cliente" (`FACTURA_CON_PAGOS`); con línea en
 *    una factura de venta aprobada/facturada tampoco (`FACTURA_YA_COBRADA`).
 *    Se evalúa sobre CAMBIOS REALES frente a la fila actual (la pantalla manda
 *    todos los campos en cada guardado). Siempre editables: concepto,
 *    producto Siigo, fecha y archivo.
 *  - USD: moneda + valor en dólares + TRM; el valor en pesos manda. Aviso si se
 *    aleja más de 5 % de USD × TRM. Re-expresión del valor en pesos solo ADMIN.
 *  - Fechas-calendario: 00:00 UTC del día (sin corrimiento por la hora de Bogotá).
 *  - Bloqueo: DO primero (`bloquearTramites`) y luego la factura, el mismo
 *    orden que usan los pagos y el cierre del DO (§B.5).
 */

import {
  EstadoBorrador,
  EstadoFacturaProveedor,
  EstadoTramite,
  Moneda,
  OrigenMovimientoCuenta,
  Prisma,
  RolCuenta,
  TipoAjusteFacturaProveedor,
} from "@prisma/client";

import { BeneficiarioNoEncontradoError } from "@/lib/beneficiarios/service";
import { ensureBorrador } from "@/lib/borradores/service";
import { bloquearTramites } from "@/lib/cxp/bloqueos";
import {
  FacturaConPagosError,
  FacturaDuplicadaError,
  FacturaEnCuentaCorrienteError,
  FacturaProveedorConPagosError,
  FacturaProveedorDuplicadaError,
  FacturaProveedorNoEncontradaError,
  FacturaYaCobradaError,
  PosibleDuplicadoError,
  ProveedorObligatorioError,
  TramiteSinPagosError,
  UsdValorLejosDeTrmError,
  type CoincidenciaFactura,
} from "@/lib/cxp/errores";
import {
  claveProveedorDeFicha,
  digitosSignificativos,
  doCorto,
  estadoDe,
  etiquetaDe,
  evaluarValorUsd,
  formatoPesos,
  nitBaseDe,
  normalizarNumeroFactura,
  numeroFacturaVisible,
  saldoDe,
  type EstadoCxp,
  type EtiquetaCxp,
  type PartesFactura,
} from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import { aFechaCalendario, fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import { assertTramiteModificable } from "@/lib/tramites/guard";
import { transitionTramite } from "@/lib/tramites/service";

type Tx = Prisma.TransactionClient;
type MonedaFactura = "COP" | "USD";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type CrearFacturaProveedorInput = {
  tramiteId: string;
  /**
   * @deprecated Se ignora: el nombre guardado sale de la ficha de pago
   * (`beneficiarioId`). Se acepta para no romper clientes viejos (MCP, scripts).
   */
  proveedorNombre?: string;
  /** @deprecated Se ignora: el NIT guardado sale de la ficha de pago. */
  proveedorNit?: string | null;
  /** Ficha de pago del proveedor. Obligatoria (R7): sin ella → `PROVEEDOR_OBLIGATORIO`. */
  beneficiarioId: string;
  concepto?: string | null;
  siigoProductoId?: string | null;
  numFactura: string;
  /** COP entero > 0. En facturas USD es el valor en pesos (el que manda y se paga). */
  valor: bigint;
  /** Fecha-calendario: se guarda como 00:00 UTC del día (`aFechaCalendario`). */
  fecha: Date;
  // La obligatoriedad del archivo (p.4) se valida en la capa API (Zod del endpoint).
  // El servicio lo acepta opcional para scripts de importación histórica y generación interna.
  documentoId?: string | null;
  /** ¿Se traslada al cliente en la factura de venta? (M6). Default `true`. */
  repercutible?: boolean;
  /** Default COP. */
  moneda?: MonedaFactura;
  /** Solo USD: centavos de dólar (USD 131,00 → 13100n). */
  valorOrigenCentavos?: bigint | null;
  /** Solo USD: centavos de peso por dólar (3.710,50 → 371050n). */
  trmCentavos?: bigint | null;
  /** Solo USD: fecha-calendario de la TRM. */
  fechaTrm?: Date | null;
  /** Reenvío tras `POSIBLE_DUPLICADO`. */
  confirmarPosibleDuplicado?: boolean;
  /** Reenvío tras `USD_VALOR_LEJOS_DE_TRM`. */
  confirmarValorUsd?: boolean;
  subidaPorId: string;
};

export type ActualizarFacturaProveedorInput = {
  /** Solo se usa en facturas heredadas sin ficha (si hay ficha, el nombre sale de ella). */
  proveedorNombre?: string;
  /** Solo se usa en facturas heredadas sin ficha. */
  proveedorNit?: string | null;
  /** `null` explícito → `PROVEEDOR_OBLIGATORIO`. */
  beneficiarioId?: string | null;
  concepto?: string | null;
  siigoProductoId?: string | null;
  numFactura?: string;
  valor?: bigint;
  fecha?: Date;
  documentoId?: string | null;
  repercutible?: boolean;
  moneda?: MonedaFactura;
  valorOrigenCentavos?: bigint | null;
  trmCentavos?: bigint | null;
  fechaTrm?: Date | null;
  confirmarPosibleDuplicado?: boolean;
  confirmarValorUsd?: boolean;
};

export type ReexpresarFacturaUsdInput = {
  /** Nuevo valor en pesos (> 0, ≥ lo ya pagado de la factura). */
  valor: bigint;
  trmCentavos: bigint;
  /** null/ausente → se conserva la fecha de TRM actual. */
  fechaTrm?: Date | null;
  motivo: string;
  confirmarValorUsd?: boolean;
};

// ─── Errores tipados ──────────────────────────────────────────────────────────
// PUENTE P0 (CxP v2): las clases viven en `@/lib/cxp/errores` (una sola
// definición; `instanceof` sigue funcionando para quien las importe de aquí).

export {
  FacturaProveedorConPagosError,
  FacturaProveedorDuplicadaError,
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
  TramiteSinPagosError,
  TransicionEstadoInvalidaError,
} from "@/lib/cxp/errores";

// PUENTE P0 → P1 (CxP v2): "Generar pago" vive en `@/lib/pagos/generar-desde-factura`
// (dueño P1). Se re-exporta aquí para no romper rutas, MCP ni pruebas.
export { generarPagoDesdeFactura, type GenerarPagoInput } from "@/lib/pagos/generar-desde-factura";

/**
 * No se puede borrar la factura: tiene ajustes, está cruzada o ya está en un
 * borrador de factura de venta. Extiende el error heredado de "tiene pagos"
 * (mismo status 422 en las rutas), con un mensaje que dice qué hacer.
 */
export class FacturaProveedorNoEliminableError extends FacturaProveedorConPagosError {
  public readonly codigo = "FACTURA_NO_ELIMINABLE" as const;
  constructor(facturaId: string, mensaje: string) {
    super(facturaId);
    this.message = mensaje;
    this.name = "FacturaProveedorNoEliminableError";
  }
}

/** Datos imposibles que el esquema de la API ya rechaza, pero que un script o el MCP podrían mandar. */
export class FacturaProveedorDatosInvalidosError extends Error {
  public readonly status = 422;
  public readonly codigo = "FACTURA_DATOS_INVALIDOS" as const;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "FacturaProveedorDatosInvalidosError";
  }
}

/** Re-expresión USD no permitida (factura en pesos, o valor por debajo de lo ya pagado). */
export class ReexpresionUsdInvalidaError extends Error {
  public readonly status = 422;
  public readonly codigo = "REEXPRESION_USD_INVALIDA" as const;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ReexpresionUsdInvalidaError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

const ESTADOS_BORRADOR_COBRADO: EstadoBorrador[] = [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO];

/** Nombre del índice único de la llave (M3). */
const INDICE_LLAVE_PROVEEDOR = "factura_proveedor_proveedorClave_numFacturaNormalizado_key";

const MENSAJE_USD_INCOMPLETO =
  "Una factura en dólares necesita el valor en dólares y la TRM (ambos mayores que cero).";

type FichaProveedor = {
  id: string;
  nombre: string;
  nombreCorto: string | null;
  nit: string | null;
  nitBase: string | null;
  numFacturaConEspacio: boolean;
  empresaId: string | null;
};

const selectFicha = {
  id: true,
  nombre: true,
  nombreCorto: true,
  nit: true,
  nitBase: true,
  numFacturaConEspacio: true,
  empresaId: true,
} satisfies Prisma.BeneficiarioSelect;

/** Nombre del proveedor en los mensajes: el nombre corto de la ficha ("ALMACARGA") o su nombre. */
function nombreVisible(ficha: Pick<FichaProveedor, "nombre" | "nombreCorto">): string {
  return ficha.nombreCorto?.trim() || ficha.nombre.trim();
}

async function fichaDeProveedor(tx: Tx, beneficiarioId: string | null | undefined): Promise<FichaProveedor> {
  if (!beneficiarioId || beneficiarioId.trim() === "") {
    throw new ProveedorObligatorioError();
  }
  const ficha = await tx.beneficiario.findUnique({ where: { id: beneficiarioId }, select: selectFicha });
  if (!ficha) {
    throw new BeneficiarioNoEncontradoError(beneficiarioId);
  }
  return ficha;
}

/** Facturas del mismo proveedor: misma clave (columna) o ficha con el mismo NIT base (o la misma ficha). */
function filtroMismoProveedor(ficha: FichaProveedor): Prisma.FacturaProveedorWhereInput {
  return {
    OR: [
      { proveedorClave: claveProveedorDeFicha(ficha) },
      { beneficiario: ficha.nitBase !== null ? { nitBase: ficha.nitBase } : { id: ficha.id } },
    ],
  };
}

/**
 * R12. Duro: mismo proveedor + mismo número normalizado → `FACTURA_DUPLICADA`.
 * Aviso: mismos dígitos significativos con otro texto ("12481" vs "FE-12481",
 * "FE 012481") → `POSIBLE_DUPLICADO`, salvo que se confirme.
 */
async function verificarDuplicados(
  tx: Tx,
  i: { ficha: FichaProveedor; numFactura: string; excluirId?: string; confirmarPosibleDuplicado: boolean },
): Promise<void> {
  const normalizado = normalizarNumeroFactura(i.numFactura);
  const digitos = digitosSignificativos(i.numFactura);
  if (normalizado === "" && digitos === "") return;

  const delProveedor = await tx.facturaProveedor.findMany({
    where: {
      AND: [filtroMismoProveedor(i.ficha), ...(i.excluirId ? [{ id: { not: i.excluirId } }] : [])],
    },
    select: {
      id: true,
      numFactura: true,
      numFacturaNormalizado: true,
      valor: true,
      tramite: { select: { consecutivo: true, anio: true, numero: true } },
    },
    orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
  });

  const proveedor = nombreVisible(i.ficha);

  if (normalizado !== "") {
    const igual = delProveedor.find(
      (f) => (f.numFacturaNormalizado ?? normalizarNumeroFactura(f.numFactura)) === normalizado,
    );
    if (igual) {
      throw new FacturaDuplicadaError({
        numFactura: numeroFacturaVisible(i.numFactura, i.ficha.numFacturaConEspacio),
        proveedor,
        doCorto: doCorto(igual.tramite.anio, igual.tramite.numero),
        consecutivo: igual.tramite.consecutivo,
        facturaId: igual.id,
      });
    }
  }

  if (digitos !== "" && !i.confirmarPosibleDuplicado) {
    const coincidencias: CoincidenciaFactura[] = delProveedor
      .filter((f) => digitosSignificativos(f.numFactura) === digitos)
      .map((f) => ({
        facturaId: f.id,
        numFactura: f.numFactura,
        doCorto: doCorto(f.tramite.anio, f.tramite.numero),
        consecutivo: f.tramite.consecutivo,
        valor: f.valor,
      }));
    if (coincidencias.length > 0) {
      throw new PosibleDuplicadoError(proveedor, coincidencias);
    }
  }
}

/**
 * Empresas (Cliente) dueñas de esta ficha, el INVERSO exacto de
 * `fichasDeEmpresa` (CxP v2): esa función suma, para una empresa, sus fichas
 * propias más las sueltas cuyo NIT base coincida con el de la empresa O con el
 * de CUALQUIERA de sus fichas propias (`bases = {nitBase(empresa)} ∪
 * {nitBase de cada ficha propia}`). Si aquí solo se mirara el NIT de la
 * empresa, una ficha suelta que comparte base con una ficha PROPIA de la
 * empresa (pero no con `Cliente.nit`, típico cuando el NIT de la empresa
 * quedó sin guion y su ficha propia sí lo tiene) entraría en la cuenta
 * corriente de esa empresa sin que este chequeo la viera nunca — la misma
 * factura pasaría dos veces, una a mano y otra como `FacturaProveedor`. Si la
 * ficha está enlazada (`empresaId`), esa es la única dueña. Sin NIT base y sin
 * enlazar, la ficha no es de ninguna empresa (no puede chocar con la cuenta
 * corriente de nadie).
 */
async function empresasDeFicha(tx: Tx, ficha: Pick<FichaProveedor, "empresaId" | "nitBase">): Promise<string[]> {
  if (ficha.empresaId) return [ficha.empresaId];
  if (!ficha.nitBase) return [];

  const [clientes, fichasHermanasPropias] = await Promise.all([
    tx.cliente.findMany({ select: { id: true, nit: true } }),
    // Empresas que tienen una ficha PROPIA con este mismo NIT base: para
    // ellas, `fichasDeEmpresa` suma esta suelta aunque el NIT de la empresa
    // sea otro.
    tx.beneficiario.findMany({
      where: { empresaId: { not: null }, nitBase: ficha.nitBase },
      select: { empresaId: true },
    }),
  ]);

  const dueñas = new Set<string>();
  for (const c of clientes) {
    if (nitBaseDe(c.nit) === ficha.nitBase) dueñas.add(c.id);
  }
  for (const f of fichasHermanasPropias) {
    if (f.empresaId) dueñas.add(f.empresaId);
  }
  return [...dueñas];
}

/**
 * La misma factura puede haber entrado ya por el otro camino: "Registrar
 * factura" en la cuenta corriente de la empresa dueña de esta ficha
 * (`MovimientoCuenta` rol PROVEEDOR — CARGO_MANUAL, pero también AJUSTE o
 * COMISION: `movimientoCuentaSchema` permite `numeroFactura` con cualquiera de
 * los tres, así que se busca en los tres), para facturas que no son de ningún
 * trámite (caso Coldex). Sin eso, se contaría la misma deuda dos veces.
 *
 * Toma el advisory lock `cuenta_corriente:<empresaId>` de cada empresa dueña
 * (mismo lock, mismo orden — ascendente — que usan `registrarMovimientoCuenta`
 * y `eliminarMovimientoCuenta`) ANTES de mirar `movimiento_cuenta`, y lo
 * mantiene hasta que la transacción de quien llama confirme la factura: así
 * "Registrar factura" en la cuenta corriente y "crear factura de proveedor" en
 * un DO no pueden colarse los dos a la vez con la misma factura (cada uno
 * chequea contra la tabla del otro sin verlo si no hay lock compartido).
 */
async function verificarNoRegistradaEnCuentaCorriente(
  tx: Tx,
  i: { ficha: FichaProveedor; numFactura: string },
): Promise<void> {
  const normalizado = normalizarNumeroFactura(i.numFactura);
  if (normalizado === "") return;

  const empresaIds = await empresasDeFicha(tx, i.ficha);
  if (empresaIds.length === 0) return;

  // Orden fijo (ascendente) para que dos llamadas que compitan por las mismas
  // empresas no se abracen esperándose (deadlock) por pedir los locks al revés.
  for (const empresaId of [...empresaIds].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cuenta_corriente:${empresaId}`}))`;
  }

  const movimiento = await tx.movimientoCuenta.findFirst({
    where: {
      empresaId: { in: empresaIds },
      rol: RolCuenta.PROVEEDOR,
      origen: { not: OrigenMovimientoCuenta.COMPENSACION },
      numeroFacturaNorm: normalizado,
    },
    select: { numeroFactura: true, fecha: true },
    orderBy: { fecha: "asc" },
  });
  if (movimiento) {
    throw new FacturaEnCuentaCorrienteError(
      movimiento.numeroFactura ?? i.numFactura,
      nombreVisible(i.ficha),
      movimiento.fecha,
    );
  }
}

function esP2002(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** ¿El P2002 es del índice de la llave proveedor + número normalizado? */
function esChoqueLlaveProveedor(e: Prisma.PrismaClientKnownRequestError): boolean {
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  const texto = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return (
    texto.includes("proveedorClave") ||
    texto.includes("numFacturaNormalizado") ||
    texto.includes(INDICE_LLAVE_PROVEEDOR) ||
    e.message.includes(INDICE_LLAVE_PROVEEDOR)
  );
}

function esChoqueTramiteNumero(e: Prisma.PrismaClientKnownRequestError): boolean {
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  const texto = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return texto.includes("tramiteId") && texto.includes("numFactura") && !texto.includes("Normalizado");
}

/**
 * Traduce el P2002 de una alta/edición que chocó (dos altas simultáneas que
 * pasaron la validación a la vez). Corre FUERA de la transacción abortada.
 * Exportada solo para probarla con un P2002 real (no es API del módulo).
 */
export async function traducirChoqueUnico(
  e: unknown,
  i: { beneficiarioId: string | null; numFactura: string; tramiteId: string },
): Promise<unknown> {
  if (!esP2002(e)) return e;
  if (esChoqueTramiteNumero(e)) {
    return new FacturaProveedorDuplicadaError(i.tramiteId, i.numFactura);
  }
  if (!esChoqueLlaveProveedor(e) || !i.beneficiarioId) return e;

  const ficha = await prisma.beneficiario.findUnique({ where: { id: i.beneficiarioId }, select: selectFicha });
  if (!ficha) return e;
  const existente = await prisma.facturaProveedor.findFirst({
    where: {
      proveedorClave: claveProveedorDeFicha(ficha),
      numFacturaNormalizado: normalizarNumeroFactura(i.numFactura),
    },
    select: { id: true, tramite: { select: { consecutivo: true, anio: true, numero: true } } },
  });
  return new FacturaDuplicadaError({
    numFactura: numeroFacturaVisible(i.numFactura, ficha.numFacturaConEspacio),
    proveedor: nombreVisible(ficha),
    doCorto: existente ? doCorto(existente.tramite.anio, existente.tramite.numero) : "?",
    consecutivo: existente?.tramite.consecutivo ?? "otro DO",
    ...(existente ? { facturaId: existente.id } : {}),
  });
}

/**
 * R14 sobre el estado final de la factura: USD exige valor en dólares y TRM
 * (> 0); si el valor en pesos se aleja más de 5 % de USD × TRM, pide confirmar.
 */
function validarUsd(i: {
  moneda: MonedaFactura;
  valor: bigint;
  valorOrigenCentavos: bigint | null;
  trmCentavos: bigint | null;
  confirmarValorUsd: boolean;
  revisarDistancia: boolean;
}): void {
  if (i.moneda !== "USD") return;
  if (!i.valorOrigenCentavos || i.valorOrigenCentavos <= 0n || !i.trmCentavos || i.trmCentavos <= 0n) {
    throw new FacturaProveedorDatosInvalidosError(MENSAJE_USD_INCOMPLETO);
  }
  if (!i.revisarDistancia || i.confirmarValorUsd) return;
  const r = evaluarValorUsd({
    valorOrigenCentavos: i.valorOrigenCentavos,
    trmCentavos: i.trmCentavos,
    valor: i.valor,
  });
  if (r.lejos) {
    throw new UsdValorLejosDeTrmError({
      valorOrigenCentavos: i.valorOrigenCentavos,
      trmCentavos: i.trmCentavos,
      sugerido: r.sugerido,
      valor: i.valor,
      diferenciaPorcentaje: r.diferenciaPorcentaje,
    });
  }
}

function validarNumeroYValor(numFactura: string, valor: bigint): void {
  if (normalizarNumeroFactura(numFactura) === "") {
    throw new FacturaProveedorDatosInvalidosError("El número de factura debe tener al menos una letra o un número.");
  }
  if (valor <= 0n) {
    throw new FacturaProveedorDatosInvalidosError("El valor de la factura debe ser mayor que cero.");
  }
}

/** `SELECT … FOR UPDATE` de la factura (después de bloquear su DO: orden único DO → factura). */
async function bloquearFactura(tx: Tx, facturaId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "factura_proveedor" WHERE id = ${facturaId} FOR UPDATE`,
  );
}

const includeFacturaParaReglas = {
  pagos: { select: { pagoId: true, monto: true } },
  ajustes: { select: { id: true, monto: true, tipo: true } },
  beneficiario: { select: selectFicha },
  tramite: { select: { id: true, consecutivo: true, estado: true, cliente: { select: { nombre: true } } } },
  lineasRevision: {
    select: {
      linea: {
        select: {
          borrador: {
            select: {
              id: true,
              estado: true,
              numFacturaSiigo: true,
              factura: { select: { numSiigo: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.FacturaProveedorInclude;

type FacturaParaReglas = Prisma.FacturaProveedorGetPayload<{ include: typeof includeFacturaParaReglas }>;

function partesDe(f: Pick<FacturaParaReglas, "valor" | "pagos" | "ajustes" | "montoCompensado">): PartesFactura {
  return {
    valor: f.valor,
    aplicado: f.pagos.reduce((s, p) => s + p.monto, 0n),
    ajustes: f.ajustes.reduce((s, a) => s + a.monto, 0n),
    compensado: f.montoCompensado,
  };
}

/** ¿Tiene plata aplicada (pagos, aunque sean enlaces heredados en 0), ajustes o cruce? */
function estaSaldada(f: FacturaParaReglas): boolean {
  return f.pagos.length > 0 || f.ajustes.length > 0 || f.montoCompensado > 0n || f.compensacionId !== null;
}

type LineaConBorrador = {
  linea: {
    borrador: {
      estado: EstadoBorrador;
      numFacturaSiigo: string | null;
      factura: { numSiigo: string } | null;
    };
  };
};

/**
 * Línea en una factura de venta APROBADA/FACTURADA → "ya se le cobró al
 * cliente". `documentoVenta` = "BAQ-18742" o, si aún no tiene número, una
 * descripción de la factura de venta del DO.
 */
function cobroDe(
  lineas: readonly LineaConBorrador[],
  consecutivo: string,
): { documentoVenta: string; numSiigo: string | null; estado: EstadoBorrador } | null {
  for (const lr of lineas) {
    const b = lr.linea.borrador;
    if (ESTADOS_BORRADOR_COBRADO.includes(b.estado)) {
      const numSiigo = b.numFacturaSiigo ?? b.factura?.numSiigo ?? null;
      return {
        documentoVenta: numSiigo ?? `la factura de venta del ${consecutivo} (${b.estado.toLowerCase()})`,
        numSiigo,
        estado: b.estado,
      };
    }
  }
  return null;
}

function cobroAlCliente(f: FacturaParaReglas) {
  return cobroDe(f.lineasRevision, f.tramite.consecutivo);
}

/** La fila sin sus relaciones (para el AuditLog). */
function filaSinRelaciones(f: FacturaParaReglas) {
  const { pagos, ajustes, beneficiario, tramite, lineasRevision, ...fila } = f;
  void pagos;
  void ajustes;
  void beneficiario;
  void tramite;
  void lineasRevision;
  return fila;
}

async function cargarFacturaBloqueada(tx: Tx, facturaId: string, tramiteId: string): Promise<FacturaParaReglas> {
  await bloquearTramites(tx, [tramiteId]);
  await bloquearFactura(tx, facturaId);
  const factura = await tx.facturaProveedor.findUnique({
    where: { id: facturaId },
    include: includeFacturaParaReglas,
  });
  if (!factura) {
    throw new FacturaProveedorNoEncontradaError(facturaId);
  }
  return factura;
}

async function tramiteDeFactura(facturaId: string): Promise<string> {
  const f = await prisma.facturaProveedor.findUnique({ where: { id: facturaId }, select: { tramiteId: true } });
  if (!f) throw new FacturaProveedorNoEncontradaError(facturaId);
  return f.tramiteId;
}

function mismaFecha(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Crea una factura de proveedor para un trámite (R7, R12, R14, R17).
 * - Ficha de pago obligatoria; nombre y NIT salen de la ficha.
 * - Duplicado duro por proveedor + número normalizado; aviso por dígitos.
 * - USD: valor en dólares + TRM; aviso si el valor en pesos se aleja > 5 %.
 */
export async function crearFacturaProveedor(input: CrearFacturaProveedorInput) {
  const {
    tramiteId,
    beneficiarioId,
    concepto,
    siigoProductoId,
    valor,
    documentoId,
    repercutible,
    subidaPorId,
  } = input;
  const numFactura = input.numFactura.trim();
  const fecha = aFechaCalendario(input.fecha);
  const moneda: MonedaFactura = input.moneda ?? "COP";
  const valorOrigenCentavos = moneda === "USD" ? (input.valorOrigenCentavos ?? null) : null;
  const trmCentavos = moneda === "USD" ? (input.trmCentavos ?? null) : null;
  const fechaTrm = moneda === "USD" && input.fechaTrm ? aFechaCalendario(input.fechaTrm) : null;

  try {
    return await prisma.$transaction(async (tx) => {
      // DO bloqueado antes de validar: un cierre simultáneo no deja pasar una
      // factura nueva a un DO que se está cerrando (R10).
      await bloquearTramites(tx, [tramiteId]);
      await assertTramiteModificable(tx, tramiteId);

      const ficha = await fichaDeProveedor(tx, beneficiarioId);
      validarNumeroYValor(numFactura, valor);
      if (moneda === "COP" && (input.valorOrigenCentavos != null || input.trmCentavos != null)) {
        throw new FacturaProveedorDatosInvalidosError(
          "Una factura en pesos no lleva valor en dólares ni TRM: cambia la moneda a USD o borra esos campos.",
        );
      }
      validarUsd({
        moneda,
        valor,
        valorOrigenCentavos,
        trmCentavos,
        confirmarValorUsd: input.confirmarValorUsd ?? false,
        revisarDistancia: true,
      });

      await verificarDuplicados(tx, {
        ficha,
        numFactura,
        confirmarPosibleDuplicado: input.confirmarPosibleDuplicado ?? false,
      });
      await verificarNoRegistradaEnCuentaCorriente(tx, { ficha, numFactura });

      // Unicidad heredada por DO + texto crudo (otro proveedor, mismo número en el mismo DO).
      const existente = await tx.facturaProveedor.findUnique({
        where: { tramiteId_numFactura: { tramiteId, numFactura } },
        select: { id: true },
      });
      if (existente) {
        throw new FacturaProveedorDuplicadaError(tramiteId, numFactura);
      }

      const factura = await tx.facturaProveedor.create({
        data: {
          tramiteId,
          proveedorNombre: ficha.nombre,
          proveedorNit: ficha.nit,
          beneficiarioId: ficha.id,
          concepto: concepto ?? null,
          siigoProductoId: siigoProductoId ?? null,
          numFactura,
          valor,
          fecha,
          documentoId,
          repercutible: repercutible ?? true,
          moneda: moneda === "USD" ? Moneda.USD : Moneda.COP,
          valorOrigenCentavos,
          trmCentavos,
          fechaTrm,
          subidaPorId,
        },
      });

      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: factura.id,
          accion: "CREATE",
          usuarioId: subidaPorId,
          tramiteId,
          despues: normalizeSerializable({
            ...factura,
            ...(input.confirmarPosibleDuplicado ? { confirmoPosibleDuplicado: true } : {}),
            ...(input.confirmarValorUsd ? { confirmoValorUsd: true } : {}),
          }),
        },
      });

      // Fila hidratada igual que `listarPorTramite` (mismo alias `valorOrigen`/
      // `trm`, `numFacturaVisible`, saldo, etc.): sin esto la pantalla del DO
      // no mostraba "USD · TRM" recién guardada, solo tras recargar (una
      // factura nueva no tiene pagos/ajustes/cruce/línea de borrador todavía).
      return {
        ...factura,
        beneficiario: ficha,
        aplicado: 0n,
        ajustado: 0n,
        compensado: 0n,
        saldo: factura.valor,
        etiqueta: "Pendiente" as EtiquetaCxp,
        numFacturaVisible: numeroFacturaVisible(factura.numFactura, ficha.numFacturaConEspacio),
        valorOrigen: factura.valorOrigenCentavos,
        trm: factura.trmCentavos,
        facturadaAlCliente: null,
        bloqueoEdicion: null,
        puedeEliminar: true,
        pagos: [],
        ajustes: [],
      };
    });
  } catch (e) {
    throw await traducirChoqueUnico(e, { beneficiarioId: beneficiarioId ?? null, numFactura, tramiteId });
  }
}

/** Fila de "Facturas proveedor" del DO (JSON: BigInt → string). */
export type FacturaProveedorFila = Awaited<ReturnType<typeof listarPorTramite>>[number];

/**
 * Lista las facturas de proveedor de un trámite con su saldo (R1) y lo que la
 * pantalla necesita para R11 (§D.3): aplicado, ajustado, compensado, saldo,
 * estado derivado, etiqueta, número visible ("FE 12481"), si ya se le cobró
 * al cliente y por qué no se puede editar el dinero o borrar.
 */
export async function listarPorTramite(tramiteId: string) {
  const facturas = await prisma.facturaProveedor.findMany({
    where: { tramiteId },
    include: {
      subidoPor: { select: { id: true, name: true, email: true } },
      documento: { select: { id: true, nombreArchivo: true, storageKey: true } },
      beneficiario: {
        select: { id: true, nombre: true, nit: true, nombreCorto: true, nitBase: true, numFacturaConEspacio: true },
      },
      pagos: {
        include: {
          pago: {
            select: { id: true, valor: true, canalPago: true, fechaRealPago: true, grupoPagoId: true },
          },
        },
      },
      ajustes: { select: { id: true, tipo: true, monto: true, motivo: true, createdAt: true } },
      tramite: { select: { consecutivo: true, cliente: { select: { nombre: true } } } },
      lineasRevision: {
        select: {
          linea: {
            select: {
              borrador: {
                select: {
                  id: true,
                  estado: true,
                  numFacturaSiigo: true,
                  factura: { select: { numSiigo: true } },
                },
              },
            },
          },
        },
      },
    },
    orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
  });

  return facturas.map((f) => {
    const { tramite, lineasRevision, ...fila } = f;
    const partes = partesDe(f);
    let saldo: bigint;
    let estadoCalculado: EstadoCxp;
    let etiqueta: EtiquetaCxp;
    try {
      saldo = saldoDe(partes);
      estadoCalculado = estadoDe(partes);
      etiqueta = etiquetaDe({
        ...partes,
        tieneAjusteLegado: f.ajustes.some((a) => a.tipo === TipoAjusteFacturaProveedor.LEGADO),
      });
    } catch (error) {
      // Invariante roto (dato heredado o escrito por fuera del dominio): la
      // pantalla del DO no se cae; se muestra el saldo acotado y queda en el log.
      console.error(`[facturas-proveedor] invariante de saldo roto en ${f.id}`, error);
      const bruto = partes.valor - partes.aplicado - partes.ajustes - partes.compensado;
      saldo = bruto < 0n ? 0n : bruto > partes.valor ? partes.valor : bruto;
      estadoCalculado = saldo === 0n ? "PAGADA" : saldo === partes.valor ? "REGISTRADA" : "PARCIAL";
      etiqueta = saldo === 0n ? "Pagada" : saldo === partes.valor ? "Pendiente" : "Abonada";
    }

    const cobro = cobroDe(lineasRevision, tramite.consecutivo);
    const saldada = f.pagos.length > 0 || f.ajustes.length > 0 || f.montoCompensado > 0n || f.compensacionId !== null;
    const enAlgunBorrador = lineasRevision.length > 0;
    const conEspacio = f.beneficiario?.numFacturaConEspacio ?? false;

    const bloqueoEdicion: { codigo: "FACTURA_YA_COBRADA" | "FACTURA_CON_PAGOS"; mensaje: string } | null = cobro
      ? {
          codigo: "FACTURA_YA_COBRADA",
          mensaje: new FacturaYaCobradaError(tramite.cliente.nombre, cobro.documentoVenta).message,
        }
      : saldada
        ? { codigo: "FACTURA_CON_PAGOS", mensaje: new FacturaConPagosError(partes.aplicado + partes.ajustes + partes.compensado).message }
        : null;

    return {
      ...fila,
      /** Σ montos del puente pago↔factura. */
      aplicado: partes.aplicado,
      /** Σ ajustes (v2: solo LEGADO de la migración). */
      ajustado: partes.ajustes,
      compensado: partes.compensado,
      saldo,
      /** Estado derivado del saldo (debe coincidir con `estado`; invariante I4). */
      estadoCalculado,
      etiqueta,
      /** "FE 12481" (fichas marcadas) o tal cual se digitó. */
      numFacturaVisible: numeroFacturaVisible(f.numFactura, conEspacio),
      /** Solo USD, en centavos (alias del contrato JSON §G). */
      valorOrigen: f.valorOrigenCentavos,
      trm: f.trmCentavos,
      /** "Cobrada a {cliente} en BAQ-…"; null = no cobrada (línea en borrador APROBADO/FACTURADO). */
      facturadaAlCliente: cobro
        ? {
            numSiigo: cobro.numSiigo,
            estado: cobro.estado,
            clienteNombre: tramite.cliente.nombre,
          }
        : null,
      /** R11: por qué no se puede cambiar valor, proveedor, número, moneda/TRM ni "se cobra al cliente". */
      bloqueoEdicion,
      /** R11: borrar solo sin pagos, ajustes, cruce ni línea en ningún borrador. */
      puedeEliminar: !saldada && !enAlgunBorrador,
    };
  });
}

/**
 * Actualiza una factura de proveedor (R11 sobre CAMBIOS REALES).
 * Siempre editables: concepto, producto Siigo, fecha, archivo. Valor,
 * proveedor, número, moneda/TRM y "se cobra al cliente" solo si la factura no
 * tiene pagos/ajustes/cruce (`FACTURA_CON_PAGOS`) y no se le ha cobrado al
 * cliente en una factura de venta aprobada/facturada (`FACTURA_YA_COBRADA`).
 */
export async function actualizarFacturaProveedor(
  facturaId: string,
  cambios: ActualizarFacturaProveedorInput,
  usuarioId: string,
) {
  const tramiteId = await tramiteDeFactura(facturaId);
  let beneficiarioParaChoque: string | null = null;
  let numeroParaChoque = cambios.numFactura?.trim() ?? "";

  try {
    return await prisma.$transaction(async (tx) => {
      const actual = await cargarFacturaBloqueada(tx, facturaId, tramiteId);
      await assertTramiteModificable(tx, actual.tramiteId);

      // ── Estado final pedido ──
      if (cambios.beneficiarioId === null) {
        throw new ProveedorObligatorioError();
      }
      const beneficiarioFinal =
        cambios.beneficiarioId !== undefined ? cambios.beneficiarioId : actual.beneficiarioId;
      const fichaFinal = beneficiarioFinal ? await fichaDeProveedor(tx, beneficiarioFinal) : null;
      beneficiarioParaChoque = beneficiarioFinal;

      const numeroFinal = cambios.numFactura !== undefined ? cambios.numFactura.trim() : actual.numFactura;
      numeroParaChoque = numeroFinal;
      const valorFinal = cambios.valor ?? actual.valor;
      const repercutibleFinal = cambios.repercutible ?? actual.repercutible;
      const monedaFinal: MonedaFactura = cambios.moneda ?? (actual.moneda === Moneda.USD ? "USD" : "COP");
      const valorOrigenFinal =
        monedaFinal === "USD"
          ? cambios.valorOrigenCentavos !== undefined
            ? cambios.valorOrigenCentavos
            : actual.valorOrigenCentavos
          : null;
      const trmFinal =
        monedaFinal === "USD"
          ? cambios.trmCentavos !== undefined
            ? cambios.trmCentavos
            : actual.trmCentavos
          : null;
      const fechaTrmFinal =
        monedaFinal === "USD"
          ? cambios.fechaTrm !== undefined
            ? cambios.fechaTrm
              ? aFechaCalendario(cambios.fechaTrm)
              : null
            : actual.fechaTrm
          : null;

      // Facturas heredadas sin ficha: el texto del proveedor sigue siendo editable (mismas reglas).
      const nombreLegadoFinal =
        !fichaFinal && cambios.proveedorNombre !== undefined ? cambios.proveedorNombre.trim() : actual.proveedorNombre;
      const nitLegadoFinal =
        !fichaFinal && cambios.proveedorNit !== undefined ? (cambios.proveedorNit?.trim() || null) : actual.proveedorNit;

      // ── Cambios reales ──
      const cambiaProveedor =
        beneficiarioFinal !== actual.beneficiarioId ||
        (!fichaFinal && (nombreLegadoFinal !== actual.proveedorNombre || nitLegadoFinal !== actual.proveedorNit));
      const cambiaNumero = numeroFinal !== actual.numFactura;
      const cambiaValor = valorFinal !== actual.valor;
      const cambiaRepercutible = repercutibleFinal !== actual.repercutible;
      const monedaActual: MonedaFactura = actual.moneda === Moneda.USD ? "USD" : "COP";
      const cambiaMoneda =
        monedaFinal !== monedaActual ||
        valorOrigenFinal !== actual.valorOrigenCentavos ||
        trmFinal !== actual.trmCentavos ||
        !mismaFecha(fechaTrmFinal, actual.fechaTrm);
      const cambiaDinero = cambiaProveedor || cambiaNumero || cambiaValor || cambiaRepercutible || cambiaMoneda;

      if (cambiaDinero) {
        const cobro = cobroAlCliente(actual);
        if (cobro) {
          throw new FacturaYaCobradaError(actual.tramite.cliente.nombre, cobro.documentoVenta);
        }
        if (estaSaldada(actual)) {
          const p = partesDe(actual);
          throw new FacturaConPagosError(p.aplicado + p.ajustes + p.compensado);
        }
      }

      if (cambiaNumero || cambiaValor) {
        validarNumeroYValor(numeroFinal, valorFinal);
      }
      validarUsd({
        moneda: monedaFinal,
        valor: valorFinal,
        valorOrigenCentavos: valorOrigenFinal,
        trmCentavos: trmFinal,
        confirmarValorUsd: cambios.confirmarValorUsd ?? false,
        revisarDistancia: cambiaValor || cambiaMoneda,
      });

      if (fichaFinal && (cambiaProveedor || cambiaNumero)) {
        await verificarDuplicados(tx, {
          ficha: fichaFinal,
          numFactura: numeroFinal,
          excluirId: facturaId,
          confirmarPosibleDuplicado: cambios.confirmarPosibleDuplicado ?? false,
        });
        await verificarNoRegistradaEnCuentaCorriente(tx, { ficha: fichaFinal, numFactura: numeroFinal });
      }
      if (cambiaNumero) {
        const existente = await tx.facturaProveedor.findUnique({
          where: { tramiteId_numFactura: { tramiteId: actual.tramiteId, numFactura: numeroFinal } },
          select: { id: true },
        });
        if (existente && existente.id !== facturaId) {
          throw new FacturaProveedorDuplicadaError(actual.tramiteId, numeroFinal);
        }
      }

      // ── Datos a escribir: solo lo que cambia ──
      const data: Prisma.FacturaProveedorUncheckedUpdateInput = {};
      if (cambios.concepto !== undefined) data.concepto = cambios.concepto;
      if (cambios.siigoProductoId !== undefined) data.siigoProductoId = cambios.siigoProductoId;
      if (cambios.fecha !== undefined) data.fecha = aFechaCalendario(cambios.fecha);
      if (cambios.documentoId !== undefined) data.documentoId = cambios.documentoId;
      if (cambiaProveedor) {
        if (fichaFinal) {
          data.beneficiarioId = fichaFinal.id;
          data.proveedorNombre = fichaFinal.nombre;
          data.proveedorNit = fichaFinal.nit;
        } else {
          data.proveedorNombre = nombreLegadoFinal;
          data.proveedorNit = nitLegadoFinal;
        }
      }
      if (cambiaNumero) data.numFactura = numeroFinal;
      if (cambiaValor) data.valor = valorFinal;
      if (cambiaRepercutible) data.repercutible = repercutibleFinal;
      if (cambiaMoneda) {
        data.moneda = monedaFinal === "USD" ? Moneda.USD : Moneda.COP;
        data.valorOrigenCentavos = valorOrigenFinal;
        data.trmCentavos = trmFinal;
        data.fechaTrm = fechaTrmFinal;
      }

      const filaAntes = filaSinRelaciones(actual);
      const updated = await tx.facturaProveedor.update({
        where: { id: facturaId },
        data,
      });

      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: facturaId,
          accion: "UPDATE",
          usuarioId,
          tramiteId: actual.tramiteId,
          antes: normalizeSerializable(filaAntes),
          despues: normalizeSerializable({
            ...updated,
            ...(cambios.confirmarPosibleDuplicado ? { confirmoPosibleDuplicado: true } : {}),
            ...(cambios.confirmarValorUsd ? { confirmoValorUsd: true } : {}),
          }),
        },
      });

      return updated;
    });
  } catch (e) {
    throw await traducirChoqueUnico(e, {
      beneficiarioId: beneficiarioParaChoque,
      numFactura: numeroParaChoque,
      tramiteId,
    });
  }
}

/**
 * Re-expresa en pesos una factura en dólares (D-4, solo ADMIN — lo exige la
 * ruta): nueva TRM y nuevo valor en pesos, con motivo y AuditLog. Única
 * excepción a R11: permitida aunque tenga pagos, siempre que el nuevo valor no
 * quede por debajo de lo ya pagado (+ ajustes + cruce) y la factura no se le
 * haya cobrado al cliente. El estado se recalcula del saldo (una factura
 * Pagada puede volver a Abonada si la TRM subió: faltan pesos por pagar).
 */
export async function reexpresarFacturaUsd(
  facturaId: string,
  input: ReexpresarFacturaUsdInput,
  usuarioId: string,
) {
  const tramiteId = await tramiteDeFactura(facturaId);

  return prisma.$transaction(async (tx) => {
    const actual = await cargarFacturaBloqueada(tx, facturaId, tramiteId);
    await assertTramiteModificable(tx, actual.tramiteId);

    if (actual.moneda !== Moneda.USD) {
      throw new ReexpresionUsdInvalidaError("Solo se puede re-expresar una factura en dólares.");
    }
    const cobro = cobroAlCliente(actual);
    if (cobro) {
      throw new FacturaYaCobradaError(actual.tramite.cliente.nombre, cobro.documentoVenta);
    }
    if (input.valor <= 0n || input.trmCentavos <= 0n) {
      throw new FacturaProveedorDatosInvalidosError("El valor en pesos y la TRM deben ser mayores que cero.");
    }
    const motivo = input.motivo.trim();
    if (motivo.length < 10) {
      throw new FacturaProveedorDatosInvalidosError("Escribe el motivo (al menos 10 caracteres).");
    }

    const partes = partesDe(actual);
    const saldado = partes.aplicado + partes.ajustes + partes.compensado;
    if (input.valor < saldado) {
      throw new ReexpresionUsdInvalidaError(
        `El nuevo valor en pesos (${formatoPesos(input.valor)}) es menor que lo ya pagado de la factura (${formatoPesos(saldado)}): no se puede re-expresar por debajo de lo pagado.`,
      );
    }

    validarUsd({
      moneda: "USD",
      valor: input.valor,
      valorOrigenCentavos: actual.valorOrigenCentavos,
      trmCentavos: input.trmCentavos,
      confirmarValorUsd: input.confirmarValorUsd ?? false,
      revisarDistancia: true,
    });

    const fechaTrm = input.fechaTrm ? aFechaCalendario(input.fechaTrm) : actual.fechaTrm;
    const estadoNuevo = estadoDe({ ...partes, valor: input.valor });

    const updated = await tx.facturaProveedor.update({
      where: { id: facturaId },
      data: {
        valor: input.valor,
        trmCentavos: input.trmCentavos,
        fechaTrm,
        estado: EstadoFacturaProveedor[estadoNuevo],
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaId,
        accion: "REEXPRESAR_USD",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable({
          valor: actual.valor,
          trmCentavos: actual.trmCentavos,
          fechaTrm: actual.fechaTrm,
          estado: actual.estado,
          saldo: partes.valor - saldado,
        }),
        despues: normalizeSerializable({
          valor: updated.valor,
          trmCentavos: updated.trmCentavos,
          fechaTrm: updated.fechaTrm,
          estado: updated.estado,
          saldo: input.valor - saldado,
          motivo,
          ...(input.confirmarValorUsd ? { confirmoValorUsd: true } : {}),
        }),
      },
    });

    return updated;
  });
}

/**
 * Elimina una factura de proveedor (R11): solo sin pagos, ajustes, cruce ni
 * línea en ningún borrador de factura de venta.
 */
export async function eliminarFacturaProveedor(
  facturaId: string,
  usuarioId: string,
): Promise<void> {
  const tramiteId = await tramiteDeFactura(facturaId);

  return prisma.$transaction(async (tx) => {
    const actual = await cargarFacturaBloqueada(tx, facturaId, tramiteId);
    await assertTramiteModificable(tx, actual.tramiteId);

    // pagos es PagoTramiteFactura[] (pivot N↔N)
    if (actual.pagos.length > 0) {
      throw new FacturaProveedorConPagosError(facturaId);
    }
    if (actual.ajustes.length > 0) {
      throw new FacturaProveedorNoEliminableError(
        facturaId,
        "No se puede borrar: la factura tiene un ajuste de la migración. Un administrador debe quitarlo primero.",
      );
    }
    if (actual.montoCompensado > 0n || actual.compensacionId !== null) {
      throw new FacturaProveedorNoEliminableError(
        facturaId,
        "No se puede borrar: la factura está cruzada en la cuenta corriente. Deshaz el cruce primero.",
      );
    }
    const cobro = cobroAlCliente(actual);
    if (cobro) {
      throw new FacturaYaCobradaError(actual.tramite.cliente.nombre, cobro.documentoVenta);
    }
    if (actual.lineasRevision.length > 0) {
      throw new FacturaProveedorNoEliminableError(
        facturaId,
        `No se puede borrar: la factura ya está en el borrador de la factura de venta del ${actual.tramite.consecutivo}. Quita esa línea del borrador primero.`,
      );
    }

    const filaAntes = filaSinRelaciones(actual);
    await tx.facturaProveedor.delete({ where: { id: facturaId } });

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaId,
        accion: "DELETE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(filaAntes),
      },
    });
  });
}

/**
 * Solicita la facturación de un trámite:
 * 1. Valida que el trámite tenga ≥1 pago registrado.
 * 2. Transiciona el estado del DO a ENVIADO_A_FACTURAR.
 * 3. Actualiza fechaEnviadoAFacturar.
 *
 * IMPORTANTE: La transición válida al estado ENVIADO_A_FACTURAR es desde DESPACHADO
 * (ver transitionMap en tramites/service.ts). Si el DO está en otro estado,
 * se retorna un error 422 con los estados válidos.
 */
export async function solicitarFacturacion(
  tramiteId: string,
  usuarioId: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  // Verificar que tenga pagos
  const pagosCount = await prisma.pagoTramite.count({
    where: { tramiteId },
  });

  if (pagosCount === 0) {
    throw new TramiteSinPagosError(tramiteId);
  }

  // Intentar transición usando el servicio de trámites existente
  const result = await transitionTramite(tramiteId, EstadoTramite.ENVIADO_A_FACTURAR, usuarioId);

  if (!result.ok) {
    // Incluir estados válidos en el mensaje
    return {
      ok: false,
      status: result.status,
      message: result.message,
    };
  }

  // Actualizar fechaEnviadoAFacturar
  await prisma.tramiteDO.update({
    where: { id: tramiteId },
    // Fecha-calendario: el día en Bogotá a 00:00 UTC (un envío a las 20:00 no
    // debe salir con el día siguiente en el tablero ni en el DO).
    data: { fechaEnviadoAFacturar: fechaCalendarioBogota() },
  });

  // Auto-crear borrador idempotente para PROPIO y SOCIO_LM. Nace con líneas
  // AUTO desde los pagos; el ADMIN (o Lucho, según el tipo de cliente) las
  // edita a mano en el editor de líneas.
  await ensureBorrador(tramiteId, usuarioId);

  return { ok: true };
}
