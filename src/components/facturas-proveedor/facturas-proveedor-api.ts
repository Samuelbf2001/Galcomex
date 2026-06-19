/**
 * Helpers de API para el módulo de Facturas de Proveedor.
 * BigInt serializado como string desde el backend — parsear con BigInt().
 */

import type { CanalPago } from "@/components/pagos/pagos-api";

export type EstadoFacturaProveedor = "REGISTRADA" | "PAGADA" | "FACTURADA_CLIENTE";

export type FacturaProveedorRow = {
  id: string;
  tramiteId: string;
  proveedorNombre: string;
  proveedorNit: string | null;
  beneficiarioId: string | null;
  concepto: string | null;
  numFactura: string;
  valor: string; // BigInt serializado
  fecha: string; // ISO string
  estado: EstadoFacturaProveedor;
  documentoId: string | null;
  subidaPorId: string;
  createdAt: string;
  updatedAt: string;
};

export type PagoGeneradoRow = {
  id: string;
  tramiteId: string;
  concepto: string;
  beneficiario: string | null;
  numSoporte: string | null;
  valor: string;
  canalPago: CanalPago;
  costoBancario: string;
  facturaProveedorId: string | null;
  viaSocio: boolean;
  createdAt: string;
};

export type CreateFacturaProveedorInput = {
  proveedorNombre: string;
  proveedorNit?: string | null;
  beneficiarioId?: string | null;
  concepto?: string | null;
  numFactura: string;
  valor: string; // BigInt as string
  fecha: string; // ISO string
  documentoId?: string | null;
};

export type UpdateFacturaProveedorInput = {
  proveedorNombre?: string;
  proveedorNit?: string | null;
  beneficiarioId?: string | null;
  concepto?: string | null;
  numFactura?: string;
  valor?: string;
  fecha?: string;
  documentoId?: string | null;
};

export type GenerarPagoInput = {
  canalPago: CanalPago;
  viaSocio: boolean;
  fechaRealPago?: string | null; // ISO string
};

export class FacturasProveedorApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FacturasProveedorApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // ignore
  }
  return `Error ${response.status}`;
}

function normalizeFactura(p: Record<string, unknown>): FacturaProveedorRow {
  return {
    id: String(p.id ?? ""),
    tramiteId: String(p.tramiteId ?? ""),
    proveedorNombre: String(p.proveedorNombre ?? ""),
    proveedorNit: typeof p.proveedorNit === "string" ? p.proveedorNit : null,
    beneficiarioId: typeof p.beneficiarioId === "string" ? p.beneficiarioId : null,
    concepto: typeof p.concepto === "string" ? p.concepto : null,
    numFactura: String(p.numFactura ?? ""),
    valor: String(p.valor ?? "0"),
    fecha: typeof p.fecha === "string" ? p.fecha : "",
    estado: (p.estado as EstadoFacturaProveedor) ?? "REGISTRADA",
    documentoId: typeof p.documentoId === "string" ? p.documentoId : null,
    subidaPorId: String(p.subidaPorId ?? ""),
    createdAt: String(p.createdAt ?? ""),
    updatedAt: String(p.updatedAt ?? ""),
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

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new FacturasProveedorApiError(msg, response.status);
  }

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

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al crear la factura (${response.status}).`;
    throw new FacturasProveedorApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.factura)) {
    throw new FacturasProveedorApiError("Respuesta de creación no válida.");
  }

  return normalizeFactura(payload.factura);
}

export async function deleteFacturaProveedor(facturaId: string): Promise<void> {
  const response = await fetch(`/api/facturas-proveedor/${facturaId}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });

  if (!response.ok && response.status !== 204) {
    const msg = await parseErrorMessage(response);
    throw new FacturasProveedorApiError(msg, response.status);
  }
}

export async function generarPagoDesdeFactura(
  facturaId: string,
  input: GenerarPagoInput,
): Promise<{ factura: FacturaProveedorRow; pago: PagoGeneradoRow }> {
  const response = await fetch(`/api/facturas-proveedor/${facturaId}/generar-pago`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al generar el pago (${response.status}).`;
    throw new FacturasProveedorApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.factura) || !isRecord(payload.pago)) {
    throw new FacturasProveedorApiError("Respuesta de pago no válida.");
  }

  const p = payload.pago;
  return {
    factura: normalizeFactura(payload.factura),
    pago: {
      id: String(p.id ?? ""),
      tramiteId: String(p.tramiteId ?? ""),
      concepto: String(p.concepto ?? ""),
      beneficiario: typeof p.beneficiario === "string" ? p.beneficiario : null,
      numSoporte: typeof p.numSoporte === "string" ? p.numSoporte : null,
      valor: String(p.valor ?? "0"),
      canalPago: (p.canalPago as CanalPago) ?? "OTRO",
      costoBancario: String(p.costoBancario ?? "0"),
      facturaProveedorId: typeof p.facturaProveedorId === "string" ? p.facturaProveedorId : null,
      viaSocio: p.viaSocio === true,
      createdAt: String(p.createdAt ?? ""),
    },
  };
}

export async function solicitarFacturacion(tramiteId: string): Promise<void> {
  const response = await fetch(`/api/tramites/${tramiteId}/solicitar-facturacion`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new FacturasProveedorApiError(msg, response.status);
  }
}

/** Formatea BigInt serializado como COP */
export function formatCOP(value: string): string {
  try {
    const n = BigInt(value);
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(n));
  } catch {
    return value;
  }
}

/** Parsea entrada de texto a BigInt string limpio */
export function parseBigIntInput(raw: string): string | null {
  const cleaned = raw
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\$/g, "")
    .replace(/COP/g, "")
    .trim();
  if (!cleaned || cleaned === "-") return null;
  try {
    const v = BigInt(cleaned);
    if (v <= 0n) return null;
    return v.toString();
  } catch {
    return null;
  }
}
