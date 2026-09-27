/**
 * Contratos JSON de CxP v2 entre rutas (P1/P2) y pantallas (P3–P6). Diseño §G
 * (P0 · "Contratos que entrega").
 *
 * Reglas de serialización:
 *  - Dinero: COP enteros como string sin puntos ("464077"). Nunca number.
 *  - USD: `valorOrigen` y `trm` como string en centavos ("13100", "371050").
 *  - Fechas-calendario (factura, pago, TRM): ISO "YYYY-MM-DD" (00:00 UTC del día;
 *    se muestran con `formatFechaCalendario`). Instantes (createdAt, anuladoEn):
 *    ISO completo.
 * Solo tipos: importable desde componentes cliente.
 */

import type { CostoAsumidoPor } from "@/lib/cxp/tipos";
import type { EtiquetaCxp } from "@/lib/cxp/saldos";

/** COP entero serializado ("464077"). */
export type DineroJson = string;
/** "YYYY-MM-DD". */
export type FechaCalendarioJson = string;
/** ISO 8601 completo. */
export type InstanteJson = string;

export type EstadoTramiteJson =
  | "SOLICITUD"
  | "APERTURA"
  | "EN_TRAMITE"
  | "EN_PUERTO"
  | "DESPACHADO"
  | "ENVIADO_A_FACTURAR"
  | "FACTURADO"
  | "PAGADO"
  | "CERRADO";

export type EstadoBorradorJson = "BORRADOR" | "EN_REVISION" | "APROBADO" | "FACTURADO";

export type CodigoMotivoNoPagable = "SIN_SALDO" | "DO_CERRADO" | "SIN_ANTICIPO" | "SIN_PROVEEDOR";

export type CodigoAdvertenciaPago =
  | "ANTICIPO_INSUFICIENTE"
  | "ANTICIPO_SIN_VERIFICAR"
  | "VALOR_TRANSFERIDO_DISTINTO"
  | "COSTO_NO_COBRABLE";

/** Factura de proveedor con saldo, tal como la lista "Pagar en bloque" y la ficha. */
export type FacturaElegibleJson = {
  id: string;
  /** Como se guardó ("FE-12481"). */
  numFactura: string;
  /** Formato del Excel ("FE 12481") según `numFacturaConEspacio` de la ficha. */
  numFacturaVisible: string;
  valor: DineroJson;
  aplicado: DineroJson;
  ajustes: DineroJson;
  compensado: DineroJson;
  saldo: DineroJson;
  estado: "REGISTRADA" | "PARCIAL";
  fecha: FechaCalendarioJson;
  moneda: "COP" | "USD";
  /** Solo USD: centavos de dólar. */
  valorOrigen: string | null;
  /** Solo USD: centavos de peso por dólar. */
  trm: string | null;
  tramiteId: string;
  /** "DO.BAQ26-0238". */
  tramiteConsecutivo: string;
  /** "26-0238". */
  doCorto: string;
  tramiteEstado: EstadoTramiteJson;
  /** `doCliente` + `proveedorCliente` del DO ("IM054-26 SRF"); columna PROVEEDOR del Excel. */
  marca: string | null;
  clienteId: string;
  clienteNombre: string;
  beneficiarioId: string | null;
  beneficiarioNombre: string | null;
  repercutible: boolean;
  /** Saldo del DO (anticipos aplicados − pagos) antes de este pago. */
  saldoTramite: DineroJson;
  pagable: boolean;
  motivoNoPagable: { codigo: CodigoMotivoNoPagable; mensaje: string } | null;
  advertencias: { codigo: CodigoAdvertenciaPago; mensaje: string }[];
  /** D-1: el DO puede absorber el costo bancario del bloque. */
  puedeAbsorberCosto: boolean;
  /** RF-23: la ficha del proveedor aún no se concilió con el Excel. */
  conciliacionPendiente: boolean;
  /** Compatibilidad con la pantalla de e5cd35b. */
  tieneAnticipoAplicado: boolean;
  /** "Cobrada a {cliente} en BAQ-…" (línea en borrador APROBADO/FACTURADO). null = no cobrada. */
  facturadaAlCliente: { numSiigo: string | null; estado: EstadoBorradorJson } | null;
};

export type PagoDeFacturaJson = {
  pagoId: string;
  grupoPagoId: string | null;
  fechaRealPago: FechaCalendarioJson | null;
  monto: DineroJson;
  esHistorico: boolean;
  comprobante: { documentoId: string; tramiteId: string } | null;
};

export type AjusteFacturaJson = {
  id: string;
  tipo: "NOTA_CREDITO" | "RETENCION" | "DESCUENTO" | "DIFERENCIA_CAMBIO" | "REDONDEO" | "LEGADO";
  monto: DineroJson;
  motivo: string;
  createdAt: InstanteJson;
};

/** Fila del estado de cuenta con el proveedor (§D.1): factura de cualquier estado. */
export type FilaEstadoCuentaJson = Omit<FacturaElegibleJson, "estado" | "ajustes"> & {
  /** Total de ajustes (valor − aplicado − compensado − saldo). */
  montoAjustes: DineroJson;
  estado: "REGISTRADA" | "PARCIAL" | "PAGADA";
  etiqueta: EtiquetaCxp;
  pagos: PagoDeFacturaJson[];
  ajustes: AjusteFacturaJson[];
  /** Fecha del pago que la dejó en saldo 0; null si tiene saldo (columna PAGO del Excel). */
  fechaPago: FechaCalendarioJson | null;
  /** Abonos (fecha y monto) mientras tenga saldo (columna ABONOS de la exportación). */
  abonos: { fecha: FechaCalendarioJson | null; monto: DineroJson }[];
};

/** Una fila por transferencia en "Pagos realizados" (bloque = una fila, pago suelto = una fila). */
export type PagoRealizadoJson = {
  tipo: "BLOQUE" | "SUELTO";
  /** grupoPagoId (BLOQUE) o pagoId (SUELTO). */
  id: string;
  fecha: FechaCalendarioJson | null;
  concepto: string;
  valor: DineroJson;
  aplicadoAFacturas: DineroJson;
  sinFactura: DineroJson;
  canalPago: "TRANSF_BANCOLOMBIA" | "PSE" | "TRANSF_OTROS_BANCOS";
  costoBancario: DineroJson;
  costoAsumidoPor: CostoAsumidoPor | null;
  estado: "ACTIVO" | "ANULADO";
  esHistorico: boolean;
  comprobante: { documentoId: string; tramiteId: string } | null;
  dos: { tramiteId: string; consecutivo: string; valor: DineroJson }[];
  facturas: { facturaId: string; numFactura: string; monto: DineroJson }[];
  anulacion: { motivo: string; por: string | null; en: InstanteJson } | null;
};

/** `ResumenCxp` serializado (dinero como string). */
export type ResumenCxpJson = {
  facturado: DineroJson;
  pagado: DineroJson;
  ajustado: DineroJson;
  cruzado: DineroJson;
  pendiente: DineroJson;
  pagadoSinFactura: DineroJson;
  nPendientes: number;
  nAbonadas: number;
  nPagadas: number;
};

/** `GET /api/clientes/[id]/cuenta-proveedor` (P1). */
export type EstadoCuentaProveedorJson = {
  empresa: { id: string; nombre: string; nombreCorto: string | null; esCliente: boolean; esProveedor: boolean };
  fichas: { id: string; nombre: string; nit: string | null; nombreCorto: string | null; conciliacionPendiente: boolean }[];
  /** ADMIN/REVISOR: COMPLETA. OPERATIVO: SOLO_PENDIENTES (D-6). */
  vista: "COMPLETA" | "SOLO_PENDIENTES";
  /** null para OPERATIVO (D-6). */
  resumen: ResumenCxpJson | null;
  facturas: FilaEstadoCuentaJson[];
  /** [] para OPERATIVO (D-6). */
  pagos: PagoRealizadoJson[];
  /** Fecha de la primera factura del proveedor en el sistema (D-9). */
  historialDesde: FechaCalendarioJson | null;
};

/** Cuerpo de error de toda ruta de CxP (`cuerpoErrorCxp`). */
export type ErrorCxpJson = { error: string; codigo: string; detalles?: unknown };
