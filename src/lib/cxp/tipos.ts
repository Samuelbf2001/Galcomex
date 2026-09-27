/**
 * Tipos de dominio de CxP v2 (diseño §B.1–§B.2). Solo tipos: se pueden
 * importar desde componentes cliente. Las funciones puras viven en
 * `saldos.ts` y `pagabilidad.ts`; las de BD en `aplicar.ts`,
 * `pagabilidad-bd.ts` y `estado-cuenta.ts` (P1) y `bloqueos.ts` (P0).
 */

import type { EstadoBorrador, EstadoFacturaProveedor, EstadoTramite, Moneda } from "@prisma/client";

import type { EstadoCxp, FacturaEnValidacion, SolicitudAplicacion } from "@/lib/cxp/saldos";

export type {
  DoParaCosto,
  ErrorAplicacion,
  EstadoCxp,
  EtiquetaCxp,
  FacturaEnValidacion,
  FacturaParaReparto,
  PartesFactura,
  ProveedorDePago,
  ReglaCostoBancario,
  ResultadoValidacionAplicaciones,
  ResumenCxp,
  SolicitudAplicacion,
} from "@/lib/cxp/saldos";
export type { AdvertenciaPago, EntradaPagabilidad, MotivoNoPagable } from "@/lib/cxp/pagabilidad";

/** Mismos valores que el enum Prisma `CostoBancarioAsumidoPor`. */
export type CostoAsumidoPor = "GALCOMEX" | "PRIMER_DO" | "PRORRATEADO";

/** Por dónde entra una aplicación de saldo (se guarda en el AuditLog). */
export type ModoAplicacion = "PAGO_SIMPLE" | "GENERAR_PAGO" | "BLOQUE" | "CONCILIACION" | "COMPENSACION";

/** Qué baja el saldo: un pago (puente con monto) o un cruce de cuenta corriente. */
export type OrigenSaldo =
  | { tipo: "PAGO"; pagoId: string; tramiteId: string; esHistorico: boolean }
  | { tipo: "COMPENSACION"; compensacionId: string };

/** Ficha de pago de la factura, con lo que necesitan las llaves y los textos. */
export interface FichaProveedor {
  id: string;
  nombre: string;
  nombreCorto: string | null;
  nit: string | null;
  nitBase: string | null;
  numFacturaConEspacio: boolean;
  conciliacionPendiente: boolean;
  empresaId: string | null;
}

/**
 * Factura bloqueada (`SELECT … FOR UPDATE`) con saldos frescos, lista para
 * `validarAplicaciones` / `aplicarSaldo`. La construye `bloquearFacturas` (P1).
 * `proveedorClave` (heredado de `FacturaEnValidacion`) es la clave DE LA FICHA
 * (`claveProveedorDeFicha`), no la columna; la columna va en `proveedorClaveColumna`.
 */
export interface FacturaBloqueada extends FacturaEnValidacion {
  /** N° tal como se guardó. `numFactura` (heredado) es el texto visible. */
  numFacturaOriginal: string;
  proveedorClaveColumna: string | null;
  estado: EstadoFacturaProveedor;
  repercutible: boolean;
  fecha: Date;
  createdAt: Date;
  moneda: Moneda;
  tieneAjusteLegado: boolean;
  compensacionId: string | null;
  beneficiario: FichaProveedor | null;
  tramite: {
    id: string;
    consecutivo: string;
    estado: EstadoTramite;
    clienteId: string;
    anio: number;
    numero: number;
  };
}

/** Lo que devuelve `aplicarSaldo` / `revertirSaldo` por factura. */
export interface CambioSaldoFactura {
  facturaId: string;
  monto: bigint;
  saldoAntes: bigint;
  saldoDespues: bigint;
  estadoAntes: EstadoFacturaProveedor;
  estadoDespues: EstadoCxp;
}

export interface ResultadoAplicacion {
  modo: ModoAplicacion;
  origen: OrigenSaldo;
  aplicaciones: SolicitudAplicacion[];
  cambios: CambioSaldoFactura[];
}

/** Estado del borrador que decide si un DO puede absorber el costo bancario (D-1). */
export type EstadoBorradorCosto = EstadoBorrador | null;
