/**
 * Errores tipados de cuentas por pagar a proveedores (CxP v2, diseño §B.7).
 *
 * Una sola definición para todo el sistema (P0 movió aquí las 6 clases que
 * vivían en `facturas-proveedor/service.ts`; ese archivo las re-exporta, así
 * que `instanceof` sigue funcionando en las rutas).
 *
 * Contrato de las rutas: `status` HTTP y cuerpo `{ error, codigo, detalles? }`
 * (`cuerpoErrorCxp`). Los mensajes son EXACTOS: las pruebas los buscan.
 * Sin dependencias de BD ni de Node: se puede importar desde el cliente.
 */

import type { EstadoFacturaProveedor, EstadoTramite } from "@prisma/client";

import { type ErrorAplicacion, formatoCentavos, formatoPesos } from "@/lib/cxp/saldos";

export { InvarianteCxpError } from "@/lib/cxp/saldos";

// ─── Clases heredadas (movidas tal cual desde facturas-proveedor/service.ts) ──

export class FacturaProveedorNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Factura de proveedor ${id} no encontrada`);
    this.name = "FacturaProveedorNoEncontradaError";
  }
}

export class FacturaProveedorConPagosError extends Error {
  public readonly status = 422;
  constructor(id: string) {
    super(`No se puede eliminar la factura ${id} porque tiene pagos vinculados`);
    this.name = "FacturaProveedorConPagosError";
  }
}

export class FacturaProveedorDuplicadaError extends Error {
  public readonly status = 409;
  constructor(tramiteId: string, numFactura: string) {
    super(`Ya existe una factura ${numFactura} para el trámite ${tramiteId}`);
    this.name = "FacturaProveedorDuplicadaError";
  }
}

export class FacturaProveedorNoModificableError extends Error {
  public readonly status = 422;
  constructor(id: string, estado: EstadoFacturaProveedor) {
    super(`La factura de proveedor ${id} está en estado ${estado} y no admite esta operación (solo se permite sobre facturas en estado REGISTRADA)`);
    this.name = "FacturaProveedorNoModificableError";
  }
}

export class TramiteSinPagosError extends Error {
  public readonly status = 422;
  constructor(tramiteId: string) {
    super(`El trámite ${tramiteId} no tiene pagos registrados`);
    this.name = "TramiteSinPagosError";
  }
}

export class TransicionEstadoInvalidaError extends Error {
  public readonly status = 422;
  public readonly estadosValidos: EstadoTramite[];
  constructor(estadoActual: EstadoTramite, estadoDestino: EstadoTramite, estadosValidos: EstadoTramite[]) {
    super(
      `No se puede transicionar el trámite de ${estadoActual} a ${estadoDestino}. ` +
        `Estados válidos desde ${estadoActual}: ${estadosValidos.join(", ") || "ninguno"}`,
    );
    this.name = "TransicionEstadoInvalidaError";
    this.estadosValidos = estadosValidos;
  }
}

// ─── Errores v2 con código ────────────────────────────────────────────────────

export type CodigoErrorCxp =
  | "FACTURA_SIN_SALDO"
  | "MONTO_EXCEDE_SALDO"
  | "PAGO_EXCEDE_SALDO"
  | "PAGO_NO_CUADRA"
  | "FACTURA_DE_OTRO_PROVEEDOR"
  | "PROVEEDORES_MEZCLADOS"
  | "FACTURA_SIN_PROVEEDOR"
  | "FACTURA_NO_ENCONTRADA"
  | "FACTURA_REPETIDA"
  | "FACTURA_DE_OTRO_DO"
  | "MONTO_INVALIDO"
  | "PAGO_DE_BLOQUE"
  | "PAGO_NO_EDITABLE"
  | "BLOQUE_CON_DO_CERRADO"
  | "SIN_ANTICIPO"
  | "COMPROBANTE_OBLIGATORIO"
  | "PROVEEDOR_OBLIGATORIO"
  | "FACTURA_DUPLICADA"
  | "POSIBLE_DUPLICADO"
  | "FACTURA_YA_COBRADA"
  | "FACTURA_CON_PAGOS"
  | "FACTURA_SIN_MONTO"
  | "IDEMPOTENCIA_CONFLICTO"
  | "NIT_DV_INVALIDO"
  | "NIT_NO_COINCIDE_EMPRESA"
  | "POSIBLE_BENEFICIARIO_DUPLICADO"
  | "USD_VALOR_LEJOS_DE_TRM"
  | "DO_CON_FACTURAS_PENDIENTES"
  | "BENEFICIARIO_EXISTE";

export type StatusErrorCxp = 404 | 409 | 422;

/** Detalles serializables (BigInt → string con `cuerpoErrorCxp`). */
export type DetallesErrorCxp = Record<string, unknown>;

/** Base de todos los errores v2 de CxP: `status`, `codigo`, mensaje en español y `detalles`. */
export class CxpError extends Error {
  public readonly status: StatusErrorCxp;
  public readonly codigo: CodigoErrorCxp;
  public readonly detalles: DetallesErrorCxp | undefined;
  constructor(status: StatusErrorCxp, codigo: CodigoErrorCxp, mensaje: string, detalles?: DetallesErrorCxp) {
    super(mensaje);
    this.name = "CxpError";
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

/** Une una lista para un mensaje: ["A"] → "A"; ["A","B"] → "A y B"; ["A","B","C"] → "A, B y C". */
export function unirLista(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

function contar(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export class FacturaSinSaldoError extends CxpError {
  constructor(numFactura: string, proveedor: string) {
    super(
      409,
      "FACTURA_SIN_SALDO",
      `La factura ${numFactura} de ${proveedor} ya está pagada; no se puede volver a pagar.`,
      { numFactura, proveedor },
    );
    this.name = "FacturaSinSaldoError";
  }
}

export class MontoExcedeSaldoError extends CxpError {
  constructor(numFactura: string, saldo: bigint, monto: bigint) {
    super(
      409,
      "MONTO_EXCEDE_SALDO",
      `A la factura ${numFactura} solo le faltan ${formatoPesos(saldo)} por pagar; no se le pueden aplicar ${formatoPesos(monto)}.`,
      { numFactura, saldo, monto },
    );
    this.name = "MontoExcedeSaldoError";
  }
}

export class PagoExcedeSaldoError extends CxpError {
  constructor(valor: bigint, saldoFacturas: bigint) {
    super(
      422,
      "PAGO_EXCEDE_SALDO",
      `El pago (${formatoPesos(valor)}) es mayor que lo que falta por pagar de las facturas escogidas (${formatoPesos(saldoFacturas)}). No se puede pagar de más.`,
      { valor, saldoFacturas },
    );
    this.name = "PagoExcedeSaldoError";
  }
}

export class PagoNoCuadraError extends CxpError {
  constructor(valor: bigint, sumaAplicada: bigint) {
    super(
      422,
      "PAGO_NO_CUADRA",
      `El valor del pago (${formatoPesos(valor)}) debe ser igual a lo aplicado a las facturas (${formatoPesos(sumaAplicada)}).`,
      { valor, sumaAplicada },
    );
    this.name = "PagoNoCuadraError";
  }
}

export class FacturaDeOtroProveedorError extends CxpError {
  constructor(numFactura: string, proveedorFactura: string, proveedorPago: string) {
    super(
      422,
      "FACTURA_DE_OTRO_PROVEEDOR",
      `La factura ${numFactura} es de ${proveedorFactura}, no de ${proveedorPago}.`,
      { numFactura, proveedorFactura, proveedorPago },
    );
    this.name = "FacturaDeOtroProveedorError";
  }
}

export class ProveedoresMezcladosError extends CxpError {
  constructor(numeros: readonly string[]) {
    super(
      422,
      "PROVEEDORES_MEZCLADOS",
      `Un pago va a un solo proveedor: ${unirLista(numeros)} son de proveedores distintos.`,
      { numeros: [...numeros] },
    );
    this.name = "ProveedoresMezcladosError";
  }
}

export class FacturaSinProveedorError extends CxpError {
  constructor(numFactura: string) {
    super(
      422,
      "FACTURA_SIN_PROVEEDOR",
      `La factura ${numFactura} no tiene proveedor: edítala y escoge el proveedor antes de pagarla.`,
      { numFactura },
    );
    this.name = "FacturaSinProveedorError";
  }
}

/** Factura pedida que no existe (en el lote validado por `validarAplicaciones`). */
export class FacturaAplicacionNoEncontradaError extends CxpError {
  constructor(facturaProveedorId: string) {
    super(404, "FACTURA_NO_ENCONTRADA", `Factura de proveedor ${facturaProveedorId} no encontrada.`, {
      facturaProveedorId,
    });
    this.name = "FacturaAplicacionNoEncontradaError";
  }
}

export class FacturaRepetidaError extends CxpError {
  constructor(numFactura: string) {
    super(422, "FACTURA_REPETIDA", `La factura ${numFactura} aparece dos veces en el mismo pago.`, { numFactura });
    this.name = "FacturaRepetidaError";
  }
}

export class FacturaDeOtroDoError extends CxpError {
  constructor(numFactura: string) {
    super(
      422,
      "FACTURA_DE_OTRO_DO",
      `La factura ${numFactura} es de otro DO: un pago suelto solo cubre facturas de su propio DO.`,
      { numFactura },
    );
    this.name = "FacturaDeOtroDoError";
  }
}

export class MontoInvalidoError extends CxpError {
  constructor(numFactura: string) {
    super(422, "MONTO_INVALIDO", `El monto a pagar de la factura ${numFactura} debe ser mayor que cero.`, {
      numFactura,
    });
    this.name = "MontoInvalidoError";
  }
}

export class PagoDeBloqueError extends CxpError {
  constructor(nDos: number) {
    super(
      409,
      "PAGO_DE_BLOQUE",
      `Este pago es parte de un pago en bloque (${contar(nDos, "DO", "DOs")}); para quitarlo, anula el bloque completo desde la ficha del proveedor.`,
      { nDos },
    );
    this.name = "PagoDeBloqueError";
  }
}

export class PagoNoEditableError extends CxpError {
  constructor() {
    super(
      409,
      "PAGO_NO_EDITABLE",
      "Este pago cubre facturas o es parte de un pago en bloque: para cambiar el valor o el canal, anula y registra de nuevo.",
    );
    this.name = "PagoNoEditableError";
  }
}

export class BloqueConDoCerradoError extends CxpError {
  constructor(consecutivos: readonly string[]) {
    const varios = consecutivos.length > 1;
    super(
      409,
      "BLOQUE_CON_DO_CERRADO",
      varios
        ? `No se puede anular: ${unirLista(consecutivos)} están cerrados. Un administrador debe reabrirlos primero.`
        : `No se puede anular: ${consecutivos[0] ?? "el DO"} está cerrado. Un administrador debe reabrirlo primero.`,
      { consecutivos: [...consecutivos] },
    );
    this.name = "BloqueConDoCerradoError";
  }
}

export class SinAnticipoError extends CxpError {
  constructor(consecutivo: string, clienteNombre: string) {
    super(
      422,
      "SIN_ANTICIPO",
      `El DO ${consecutivo} no tiene anticipo aplicado y ${clienteNombre} tiene encendida la función «Sin anticipo no hay pago». Aplica un anticipo o apaga la función en la ficha de ${clienteNombre}.`,
      { consecutivo, clienteNombre },
    );
    this.name = "SinAnticipoError";
  }
}

export class ComprobanteObligatorioError extends CxpError {
  constructor() {
    super(422, "COMPROBANTE_OBLIGATORIO", "Adjunta el comprobante del banco.");
    this.name = "ComprobanteObligatorioError";
  }
}

export class ProveedorObligatorioError extends CxpError {
  constructor() {
    super(422, "PROVEEDOR_OBLIGATORIO", "El proveedor es obligatorio.");
    this.name = "ProveedorObligatorioError";
  }
}

export class FacturaDuplicadaError extends CxpError {
  constructor(i: { numFactura: string; proveedor: string; doCorto: string; consecutivo: string; facturaId?: string }) {
    super(
      409,
      "FACTURA_DUPLICADA",
      `La factura ${i.numFactura} de ${i.proveedor} ya está registrada en el DO ${i.doCorto} (${i.consecutivo}).`,
      { ...i },
    );
    this.name = "FacturaDuplicadaError";
  }
}

export interface CoincidenciaFactura {
  facturaId: string;
  numFactura: string;
  doCorto: string;
  consecutivo: string;
  valor: bigint;
}

export class PosibleDuplicadoError extends CxpError {
  public readonly coincidencias: CoincidenciaFactura[];
  constructor(proveedor: string, coincidencias: CoincidenciaFactura[]) {
    const primera = coincidencias[0];
    super(
      409,
      "POSIBLE_DUPLICADO",
      primera
        ? `¿Es la misma factura? ${proveedor} ya tiene ${primera.numFactura} en el DO ${primera.doCorto} por ${formatoPesos(primera.valor)}.`
        : `¿Es la misma factura? ${proveedor} ya tiene una factura con el mismo número.`,
      { proveedor, coincidencias },
    );
    this.name = "PosibleDuplicadoError";
    this.coincidencias = coincidencias;
  }
}

export class FacturaYaCobradaError extends CxpError {
  /** `documentoVenta`: "BAQ-18742" (numSiigo) o, si aún no tiene, "el borrador del DO …". */
  constructor(clienteNombre: string, documentoVenta: string) {
    super(
      409,
      "FACTURA_YA_COBRADA",
      `Esta factura ya se le cobró a ${clienteNombre} en ${documentoVenta}: primero corrige la factura de venta.`,
      { clienteNombre, documentoVenta },
    );
    this.name = "FacturaYaCobradaError";
  }
}

export class FacturaConPagosError extends CxpError {
  /** `saldado` = aplicado + ajustes + compensado de la factura. */
  constructor(saldado: bigint) {
    super(
      409,
      "FACTURA_CON_PAGOS",
      `Esta factura ya tiene pagos por ${formatoPesos(saldado)}: no se puede cambiar el valor, el proveedor ni el número. Si llegó una nota crédito, avísale a administración.`,
      { saldado },
    );
    this.name = "FacturaConPagosError";
  }
}

export class FacturaSinMontoError extends CxpError {
  /** `alcanzaPara`: números (visibles) de las facturas que sí reciben monto en el reparto FIFO. */
  constructor(valor: bigint, alcanzaPara: readonly string[], sinMonto: readonly string[]) {
    super(
      422,
      "FACTURA_SIN_MONTO",
      `El valor (${formatoPesos(valor)}) solo alcanza para ${unirLista(alcanzaPara)}; quita las demás facturas o indica el monto de cada una.`,
      { valor, alcanzaPara: [...alcanzaPara], sinMonto: [...sinMonto] },
    );
    this.name = "FacturaSinMontoError";
  }
}

export class IdempotenciaConflictoError extends CxpError {
  constructor(motivo: "OTRO_CONTENIDO" | "ANULADO") {
    super(
      409,
      "IDEMPOTENCIA_CONFLICTO",
      "Este pago ya se registró con otros datos (o se anuló). Cierra la ventana y vuelve a abrirla para registrar uno nuevo.",
      { motivo },
    );
    this.name = "IdempotenciaConflictoError";
  }
}

export class NitDvInvalidoError extends CxpError {
  constructor(dvDigitado: number, nitBase: string, dvCorrecto: number) {
    super(
      422,
      "NIT_DV_INVALIDO",
      `El dígito de verificación ${dvDigitado} no corresponde al NIT ${nitBase} (debería ser ${dvCorrecto}).`,
      { dvDigitado, nitBase, dvCorrecto },
    );
    this.name = "NitDvInvalidoError";
  }
}

export class NitNoCoincideEmpresaError extends CxpError {
  constructor(nitBase: string, empresaNombre: string, nitEmpresa: string) {
    super(
      422,
      "NIT_NO_COINCIDE_EMPRESA",
      `El NIT ${nitBase} no es el de la empresa ${empresaNombre} (${nitEmpresa}).`,
      { nitBase, empresaNombre, nitEmpresa },
    );
    this.name = "NitNoCoincideEmpresaError";
  }
}

export interface BeneficiarioResumen {
  id: string;
  nombre: string;
  nit: string | null;
}

export class PosibleBeneficiarioDuplicadoError extends CxpError {
  public readonly existentes: BeneficiarioResumen[];
  constructor(existentes: BeneficiarioResumen[]) {
    const primero = existentes[0];
    super(
      409,
      "POSIBLE_BENEFICIARIO_DUPLICADO",
      primero
        ? `¿Es la misma empresa? Ya existe ${primero.nombre} con NIT ${primero.nit ?? "sin NIT"}.`
        : "¿Es la misma empresa? Ya existe una ficha con un NIT parecido.",
      { existentes },
    );
    this.name = "PosibleBeneficiarioDuplicadoError";
    this.existentes = existentes;
  }
}

export class BeneficiarioExisteError extends CxpError {
  public readonly existente: BeneficiarioResumen;
  constructor(existente: BeneficiarioResumen) {
    super(
      409,
      "BENEFICIARIO_EXISTE",
      `Ya existe: ${existente.nombre} (NIT ${existente.nit ?? "sin NIT"}). Usa esa ficha.`,
      { existente },
    );
    this.name = "BeneficiarioExisteError";
    this.existente = existente;
  }
}

export class UsdValorLejosDeTrmError extends CxpError {
  constructor(i: {
    valorOrigenCentavos: bigint;
    trmCentavos: bigint;
    sugerido: bigint;
    valor: bigint;
    diferenciaPorcentaje: bigint;
  }) {
    super(
      409,
      "USD_VALOR_LEJOS_DE_TRM",
      `USD ${formatoCentavos(i.valorOrigenCentavos)} × TRM ${formatoCentavos(i.trmCentavos)} = ${formatoPesos(i.sugerido)}; escribiste ${formatoPesos(i.valor)} (${i.diferenciaPorcentaje} % de diferencia). ¿Está bien?`,
      { ...i },
    );
    this.name = "UsdValorLejosDeTrmError";
  }
}

export class DoConFacturasPendientesError extends CxpError {
  constructor(consecutivo: string, facturas: readonly { numFactura: string; saldo: bigint }[]) {
    const lista = facturas.map((f) => `${f.numFactura} ${formatoPesos(f.saldo)}`).join(", ");
    super(
      422,
      "DO_CON_FACTURAS_PENDIENTES",
      `No se puede cerrar ${consecutivo}: tiene ${contar(facturas.length, "factura de proveedor sin pagar", "facturas de proveedor sin pagar")} (${lista}).`,
      { consecutivo, facturas: facturas.map((f) => ({ ...f })) },
    );
    this.name = "DoConFacturasPendientesError";
  }
}

// ─── Traducción de ErrorAplicacion (validarAplicaciones) a error tipado ──────

/** El primer error de `validarAplicaciones` como excepción tipada (los demás van en `detalles.errores`). */
export function errorDeAplicacion(errores: readonly ErrorAplicacion[]): CxpError {
  const e = errores[0];
  let error: CxpError;
  switch (e?.codigo) {
    case "FACTURA_NO_ENCONTRADA":
      error = new FacturaAplicacionNoEncontradaError(e.facturaProveedorId);
      break;
    case "FACTURA_REPETIDA":
      error = new FacturaRepetidaError(e.numFactura);
      break;
    case "FACTURA_DE_OTRO_DO":
      error = new FacturaDeOtroDoError(e.numFactura);
      break;
    case "FACTURA_SIN_PROVEEDOR":
      error = new FacturaSinProveedorError(e.numFactura);
      break;
    case "FACTURA_DE_OTRO_PROVEEDOR":
      error = new FacturaDeOtroProveedorError(e.numFactura, e.proveedorFactura, e.proveedorPago);
      break;
    case "PROVEEDORES_MEZCLADOS":
      error = new ProveedoresMezcladosError(e.numeros);
      break;
    case "FACTURA_SIN_SALDO":
      error = new FacturaSinSaldoError(e.numFactura, e.proveedor);
      break;
    case "MONTO_INVALIDO":
      error = new MontoInvalidoError(e.numFactura);
      break;
    case "MONTO_EXCEDE_SALDO":
      error = new MontoExcedeSaldoError(e.numFactura, e.saldo, e.monto);
      break;
    default:
      throw new Error("errorDeAplicacion: lista de errores vacía");
  }
  if (errores.length > 1) {
    return new CxpError(error.status, error.codigo, error.message, {
      ...(error.detalles ?? {}),
      errores: errores.map((x) => ({ ...x })),
    });
  }
  return error;
}

// ─── Guardián de BD ───────────────────────────────────────────────────────────

/** ¿El error viene del trigger guardián de saldo (`CXP_SOBREAPLICACION`)? → responder `MontoExcedeSaldoError` (409). */
export function esErrorSobreaplicacion(e: unknown): boolean {
  const texto = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return texto.includes("CXP_SOBREAPLICACION");
}

// ─── Cuerpo HTTP ──────────────────────────────────────────────────────────────

function aJson(valor: unknown): unknown {
  return JSON.parse(JSON.stringify(valor, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

/** `{ error, codigo, detalles? }` con BigInt serializado como string. */
export function cuerpoErrorCxp(e: CxpError): { error: string; codigo: CodigoErrorCxp; detalles?: unknown } {
  return e.detalles === undefined
    ? { error: e.message, codigo: e.codigo }
    : { error: e.message, codigo: e.codigo, detalles: aJson(e.detalles) };
}
