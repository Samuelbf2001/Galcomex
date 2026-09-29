/**
 * Helpers de API para el módulo de Facturas de Proveedor (CxP v2, §D.3).
 * Dinero: pesos como texto con 2 decimales desde el backend
 * (fase CENTAVOS, diseño §A.2/§A.3) — parsear con `centavosDeTextoApi`
 * (o `centavosDeTexto` si el valor viene de un JSON guardado/legado).
 * Excepción de nombre (§A.3): `valorOrigen` = USD ("131.00"),
 * `trm` = COP por USD ("3710.50"); NO son COP normales.
 *
 * Consume `GET/POST /api/tramites/[id]/facturas-proveedor`,
 * `PATCH/DELETE /api/facturas-proveedor/[id]`,
 * `POST /api/facturas-proveedor/[id]/reexpresar` y
 * `DELETE /api/facturas-proveedor/[id]/ajustes/[ajusteId]` (P1/P2).
 */

import type { CanalPago } from "@/components/pagos/pagos-api";
import { centavosDeTextoApi, formatoPesos, textoDeCentavos, type Centavos } from "@/lib/dinero";

/** Estado crudo en BD. `FACTURADA_CLIENTE` está deprecado (R13): nunca se escribe. */
export type EstadoFacturaProveedor = "REGISTRADA" | "PARCIAL" | "PAGADA" | "FACTURADA_CLIENTE";
export type Moneda = "COP" | "USD";
export type EtiquetaCxp = "Pendiente" | "Abonada" | "Pagada" | "Cruzada" | "Pagada con ajuste";

export type PagoDeFactura = {
  pagoId: string;
  monto: string;
  createdAt: string;
  valor: string;
  canalPago: CanalPago;
  fechaRealPago: string | null;
  grupoPagoId: string | null;
};

export type AjusteDeFactura = {
  id: string;
  tipo: "NOTA_CREDITO" | "RETENCION" | "DESCUENTO" | "DIFERENCIA_CAMBIO" | "REDONDEO" | "LEGADO";
  monto: string;
  motivo: string;
  createdAt: string;
};

export type FacturadaAlCliente = {
  numSiigo: string | null;
  estado: "BORRADOR" | "EN_REVISION" | "APROBADO" | "FACTURADO";
  clienteNombre: string;
} | null;

export type BloqueoEdicion = { codigo: "FACTURA_YA_COBRADA" | "FACTURA_CON_PAGOS"; mensaje: string } | null;

export type BeneficiarioDeFactura = {
  id: string;
  nombre: string;
  nit: string | null;
  nombreCorto: string | null;
  nitBase: string | null;
  numFacturaConEspacio: boolean;
} | null;

/** Fila de "Facturas proveedor" del DO — espejo del JSON de `listarPorTramite` (P2). */
export type FacturaProveedorRow = {
  id: string;
  tramiteId: string;
  proveedorNombre: string;
  proveedorNit: string | null;
  beneficiarioId: string | null;
  beneficiario: BeneficiarioDeFactura;
  concepto: string | null;
  siigoProductoId: string | null;
  numFactura: string;
  /** "FE 12481" (fichas marcadas) o tal cual se digitó. */
  numFacturaVisible: string;
  valor: string; // BigInt serializado
  fecha: string; // "YYYY-MM-DD"
  estado: EstadoFacturaProveedor;
  /** Pendiente / Abonada / Pagada / Cruzada / Pagada con ajuste (R1, R13). */
  etiqueta: EtiquetaCxp;
  moneda: Moneda;
  /** Solo USD: centavos de dólar. */
  valorOrigen: string | null;
  /** Solo USD: centavos de peso por dólar. */
  trm: string | null;
  fechaTrm: string | null;
  documentoId: string | null;
  repercutible: boolean;
  subidaPorId: string;
  createdAt: string;
  updatedAt: string;
  /** Σ montos aplicados por el puente pago↔factura. */
  aplicado: string;
  /** Σ ajustes (v2: solo LEGADO de la migración). */
  ajustado: string;
  compensado: string;
  saldo: string;
  facturadaAlCliente: FacturadaAlCliente;
  /** R11: por qué no se puede cambiar valor/proveedor/número/moneda/"se cobra al cliente"; null = sí se puede. */
  bloqueoEdicion: BloqueoEdicion;
  /** R11: solo sin pagos, ajustes, cruce ni línea en ningún borrador. */
  puedeEliminar: boolean;
  pagos: PagoDeFactura[];
  ajustes: AjusteDeFactura[];
};

export type CreateFacturaProveedorInput = {
  /** Ficha de pago del proveedor (R7, obligatoria). */
  beneficiarioId: string;
  concepto?: string | null;
  siigoProductoId?: string | null;
  numFactura: string;
  /** COP entero > 0. En USD es el valor en pesos (el que manda y se paga). */
  valor: string;
  /** "YYYY-MM-DD". */
  fecha: string;
  documentoId?: string | null;
  repercutible?: boolean;
  moneda?: Moneda;
  /** Solo USD: dólares con 2 decimales ("131.00" = USD 131,00). */
  valorOrigen?: string | null;
  /** Solo USD: pesos por dólar con 2 decimales ("3710.50" = TRM 3.710,50). */
  trm?: string | null;
  fechaTrm?: string | null;
  /** Reenvío tras 409 `POSIBLE_DUPLICADO`. */
  confirmarPosibleDuplicado?: boolean;
  /** Reenvío tras 409 `USD_VALOR_LEJOS_DE_TRM`. */
  confirmarValorUsd?: boolean;
};

export type UpdateFacturaProveedorInput = Partial<CreateFacturaProveedorInput> & {
  beneficiarioId?: string | null;
};

export type ReexpresarUsdInput = {
  /** Nuevo valor en pesos, texto de API (> 0, ≥ lo ya pagado). */
  valor: string;
  /** Pesos por dólar con 2 decimales ("3710.50"). */
  trm: string;
  fechaTrm?: string | null;
  motivo: string;
  confirmarValorUsd?: boolean;
};

/** @deprecated El modal "Generar pago" se retiró de la pantalla (D.3): el DO siempre paga con `onPagarFactura`. */
export type GenerarPagoInput = {
  canalPago: CanalPago;
  viaSocio: boolean;
  fechaRealPago?: string | null;
};

export class FacturasProveedorApiError extends Error {
  status?: number;
  /** Código del error de CxP (§B.7), p. ej. "FACTURA_DUPLICADA", "POSIBLE_DUPLICADO". */
  codigo?: string;
  detalles?: unknown;
  constructor(message: string, status?: number, codigo?: string, detalles?: unknown) {
    super(message);
    this.name = "FacturasProveedorApiError";
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function leerError(response: Response): Promise<FacturasProveedorApiError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // ignore
  }
  const mensaje =
    isRecord(payload) && typeof payload.error === "string" ? payload.error : `Error ${response.status}`;
  const codigo = isRecord(payload) && typeof payload.codigo === "string" ? payload.codigo : undefined;
  const detalles = isRecord(payload) ? payload.detalles : undefined;
  return new FacturasProveedorApiError(mensaje, response.status, codigo, detalles);
}

function normalizeBeneficiario(v: unknown): BeneficiarioDeFactura {
  if (!isRecord(v)) return null;
  return {
    id: String(v.id ?? ""),
    nombre: String(v.nombre ?? ""),
    nit: typeof v.nit === "string" ? v.nit : null,
    nombreCorto: typeof v.nombreCorto === "string" ? v.nombreCorto : null,
    nitBase: typeof v.nitBase === "string" ? v.nitBase : null,
    numFacturaConEspacio: v.numFacturaConEspacio === true,
  };
}

function normalizePago(v: unknown): PagoDeFactura | null {
  if (!isRecord(v)) return null;
  const pago = isRecord(v.pago) ? v.pago : {};
  return {
    pagoId: String(v.pagoId ?? pago.id ?? ""),
    monto: String(v.monto ?? "0"),
    createdAt: String(v.createdAt ?? ""),
    valor: String(pago.valor ?? "0"),
    canalPago: (pago.canalPago as CanalPago) ?? "TRANSF_BANCOLOMBIA",
    fechaRealPago: typeof pago.fechaRealPago === "string" ? pago.fechaRealPago : null,
    grupoPagoId: typeof pago.grupoPagoId === "string" ? pago.grupoPagoId : null,
  };
}

function normalizeAjuste(v: unknown): AjusteDeFactura | null {
  if (!isRecord(v)) return null;
  return {
    id: String(v.id ?? ""),
    tipo: (v.tipo as AjusteDeFactura["tipo"]) ?? "LEGADO",
    monto: String(v.monto ?? "0"),
    motivo: String(v.motivo ?? ""),
    createdAt: String(v.createdAt ?? ""),
  };
}

export function normalizeFactura(p: Record<string, unknown>): FacturaProveedorRow {
  const cobro = isRecord(p.facturadaAlCliente) ? p.facturadaAlCliente : null;
  const bloqueo = isRecord(p.bloqueoEdicion) ? p.bloqueoEdicion : null;
  return {
    id: String(p.id ?? ""),
    tramiteId: String(p.tramiteId ?? ""),
    proveedorNombre: String(p.proveedorNombre ?? ""),
    proveedorNit: typeof p.proveedorNit === "string" ? p.proveedorNit : null,
    beneficiarioId: typeof p.beneficiarioId === "string" ? p.beneficiarioId : null,
    beneficiario: normalizeBeneficiario(p.beneficiario),
    concepto: typeof p.concepto === "string" ? p.concepto : null,
    siigoProductoId: typeof p.siigoProductoId === "string" ? p.siigoProductoId : null,
    numFactura: String(p.numFactura ?? ""),
    numFacturaVisible: String(p.numFacturaVisible ?? p.numFactura ?? ""),
    valor: String(p.valor ?? "0"),
    fecha: typeof p.fecha === "string" ? p.fecha.slice(0, 10) : "",
    estado: (p.estado as EstadoFacturaProveedor) ?? "REGISTRADA",
    etiqueta: (p.etiqueta as EtiquetaCxp) ?? "Pendiente",
    moneda: (p.moneda as Moneda) ?? "COP",
    valorOrigen: typeof p.valorOrigen === "string" ? p.valorOrigen : p.valorOrigen == null ? null : String(p.valorOrigen),
    trm: typeof p.trm === "string" ? p.trm : p.trm == null ? null : String(p.trm),
    fechaTrm: typeof p.fechaTrm === "string" ? p.fechaTrm.slice(0, 10) : null,
    documentoId: typeof p.documentoId === "string" ? p.documentoId : null,
    repercutible: p.repercutible !== false,
    subidaPorId: String(p.subidaPorId ?? ""),
    createdAt: String(p.createdAt ?? ""),
    updatedAt: String(p.updatedAt ?? ""),
    aplicado: String(p.aplicado ?? "0"),
    ajustado: String(p.ajustado ?? "0"),
    compensado: String(p.compensado ?? "0"),
    saldo: String(p.saldo ?? p.valor ?? "0"),
    facturadaAlCliente: cobro
      ? {
          numSiigo: typeof cobro.numSiigo === "string" ? cobro.numSiigo : null,
          estado: (cobro.estado as "BORRADOR" | "EN_REVISION" | "APROBADO" | "FACTURADO") ?? "BORRADOR",
          clienteNombre: String(cobro.clienteNombre ?? ""),
        }
      : null,
    bloqueoEdicion: bloqueo
      ? {
          codigo: (bloqueo.codigo as "FACTURA_YA_COBRADA" | "FACTURA_CON_PAGOS") ?? "FACTURA_CON_PAGOS",
          mensaje: String(bloqueo.mensaje ?? ""),
        }
      : null,
    puedeEliminar: p.puedeEliminar === true,
    pagos: Array.isArray(p.pagos) ? p.pagos.map(normalizePago).filter((x): x is PagoDeFactura => x !== null) : [],
    ajustes: Array.isArray(p.ajustes) ? p.ajustes.map(normalizeAjuste).filter((x): x is AjusteDeFactura => x !== null) : [],
  };
}

export async function fetchFacturasProveedor(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<FacturaProveedorRow[]> {
  let response: Response;
  try {
    response = await fetch(`/api/tramites/${tramiteId}/facturas-proveedor`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new FacturasProveedorApiError("No fue posible conectar con la API de facturas de proveedor.");
  }

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.facturas)) {
    throw new FacturasProveedorApiError("Respuesta de facturas no válida.");
  }

  return (payload.facturas as unknown[]).filter(isRecord).map(normalizeFactura);
}

export async function createFacturaProveedor(
  tramiteId: string,
  input: CreateFacturaProveedorInput,
): Promise<FacturaProveedorRow> {
  const response = await fetch(`/api/tramites/${tramiteId}/facturas-proveedor`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.factura)) {
    throw new FacturasProveedorApiError("Respuesta de creación no válida.");
  }
  return normalizeFactura(payload.factura);
}

export async function updateFacturaProveedor(
  facturaId: string,
  input: UpdateFacturaProveedorInput,
): Promise<FacturaProveedorRow> {
  const response = await fetch(`/api/facturas-proveedor/${facturaId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.factura)) {
    throw new FacturasProveedorApiError("Respuesta de actualización no válida.");
  }
  return normalizeFactura(payload.factura);
}

export async function deleteFacturaProveedor(facturaId: string): Promise<void> {
  const response = await fetch(`/api/facturas-proveedor/${facturaId}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });

  if (!response.ok && response.status !== 204) throw await leerError(response);
}

/** POST /api/facturas-proveedor/[id]/reexpresar (D-4, solo ADMIN). */
export async function reexpresarFacturaUsd(
  facturaId: string,
  input: ReexpresarUsdInput,
): Promise<FacturaProveedorRow> {
  const response = await fetch(`/api/facturas-proveedor/${facturaId}/reexpresar`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.factura)) {
    throw new FacturasProveedorApiError("Respuesta de re-expresión no válida.");
  }
  return normalizeFactura(payload.factura);
}

/** DELETE /api/facturas-proveedor/[id]/ajustes/[ajusteId] (solo ADMIN, solo LEGADO): reabre la factura. */
export async function eliminarAjusteLegado(
  facturaId: string,
  ajusteId: string,
  motivo: string,
): Promise<void> {
  const response = await fetch(
    `/api/facturas-proveedor/${facturaId}/ajustes/${ajusteId}?motivo=${encodeURIComponent(motivo)}`,
    { method: "DELETE", headers: { accept: "application/json" } },
  );
  if (!response.ok && response.status !== 204) throw await leerError(response);
}

export async function solicitarFacturacion(tramiteId: string): Promise<void> {
  const response = await fetch(`/api/tramites/${tramiteId}/solicitar-facturacion`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({}),
  });

  if (!response.ok) throw await leerError(response);
}

/** Formatea pesos-texto de la API ("502801.45") como "$ 502.801,45" (D-5: centavos solo si existen). */
export function formatCOP(value: string): string {
  try {
    return formatoPesos(centavosDeTextoApi(value));
  } catch {
    return value;
  }
}

/** Convierte centavos del núcleo a pesos-texto de API ("502801.45", 2 decimales). */
export function textoApiDeCentavos(c: Centavos): string {
  return textoDeCentavos(c);
}
