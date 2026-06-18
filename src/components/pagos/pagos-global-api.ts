/**
 * Helpers de API para el módulo GLOBAL de pagos (vista transversal de todos los DOs).
 * La creación/edición/borrado reutiliza los endpoints por-DO de pagos-api.ts.
 * BigInt serializado como string desde el backend — parsear con BigInt().
 */

import type { CanalPago } from "@/components/pagos/pagos-api";

export type { CanalPago, CreatePagoInput, UpdatePagoInput } from "@/components/pagos/pagos-api";
export {
  CANALES_PAGO,
  PagosApiError,
  createPago,
  updatePago,
  deletePago,
  formatCOP,
} from "@/components/pagos/pagos-api";

import { PagosApiError } from "@/components/pagos/pagos-api";

/** Fila de pago en la vista global: pago + datos del DO y cliente. */
export type PagoGlobalRow = {
  id: string;
  tramiteId: string;
  consecutivo: string;
  estadoTramite: string;
  clienteId: string;
  clienteNombre: string;
  clienteNit: string;
  concepto: string;
  beneficiario: string | null;
  numSoporte: string | null;
  valor: string; // BigInt serializado
  canalPago: CanalPago;
  costoBancario: string; // BigInt serializado
  orden: number;
  fechaEsperadaPago: string | null; // ISO
  fechaRealPago: string | null; // ISO
  createdAt: string;
  updatedAt: string;
};

export type PagosGlobalData = {
  pagos: PagoGlobalRow[];
  totalPagos: string;
  costosBancarios: string;
  totalPendiente: string;
};

export type ClienteOption = { id: string; nombre: string; nit: string };
export type TramiteOption = { id: string; consecutivo: string; clienteNombre: string };

export type PagosGlobalFiltros = {
  clienteId?: string;
  tramiteId?: string;
  canalPago?: CanalPago | "";
  soloPendientes?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") return payload.error;
  } catch {
    // ignore
  }
  return `Error ${response.status}`;
}

function normalizePago(raw: unknown): PagoGlobalRow | null {
  if (!isRecord(raw)) return null;
  const tramite = isRecord(raw.tramite) ? raw.tramite : {};
  const cliente = isRecord(tramite.cliente) ? tramite.cliente : {};

  return {
    id: String(raw.id ?? ""),
    tramiteId: String(raw.tramiteId ?? tramite.id ?? ""),
    consecutivo: String(tramite.consecutivo ?? ""),
    estadoTramite: String(tramite.estado ?? ""),
    clienteId: String(cliente.id ?? ""),
    clienteNombre: String(cliente.nombre ?? ""),
    clienteNit: String(cliente.nit ?? ""),
    concepto: String(raw.concepto ?? ""),
    beneficiario: (() => {
      if (typeof raw.beneficiario === "object" && raw.beneficiario !== null) {
        const b = raw.beneficiario as Record<string, unknown>;
        return typeof b.nombre === "string" ? b.nombre : null;
      }
      return null;
    })(),
    numSoporte: typeof raw.numSoporte === "string" ? raw.numSoporte : null,
    valor: String(raw.valor ?? "0"),
    canalPago: (raw.canalPago as CanalPago) ?? "OTRO",
    costoBancario: String(raw.costoBancario ?? "0"),
    orden: typeof raw.orden === "number" ? raw.orden : 0,
    fechaEsperadaPago: typeof raw.fechaEsperadaPago === "string" ? raw.fechaEsperadaPago : null,
    fechaRealPago: typeof raw.fechaRealPago === "string" ? raw.fechaRealPago : null,
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

export async function fetchPagosGlobal(
  filtros: PagosGlobalFiltros = {},
  signal?: AbortSignal,
): Promise<PagosGlobalData> {
  const url = new URL("/api/pagos", window.location.origin);
  if (filtros.clienteId) url.searchParams.set("clienteId", filtros.clienteId);
  if (filtros.tramiteId) url.searchParams.set("tramiteId", filtros.tramiteId);
  if (filtros.canalPago) url.searchParams.set("canalPago", filtros.canalPago);
  if (filtros.soloPendientes) url.searchParams.set("solo_pendientes", "true");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con /api/pagos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new PagosApiError("Respuesta de pagos no válida.");

  const rawPagos = Array.isArray(payload.pagos) ? payload.pagos : [];
  const pagos = rawPagos
    .map(normalizePago)
    .filter((p): p is PagoGlobalRow => p !== null);

  return {
    pagos,
    totalPagos: String(payload.totalPagos ?? "0"),
    costosBancarios: String(payload.costosBancarios ?? "0"),
    totalPendiente: String(payload.totalPendiente ?? "0"),
  };
}

export async function fetchClienteOptions(signal?: AbortSignal): Promise<ClienteOption[]> {
  const response = await fetch("/api/clientes", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new PagosApiError("Error al cargar clientes.", response.status);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.clientes)) return [];

  return payload.clientes
    .filter(isRecord)
    .map((c) => ({
      id: String(c.id ?? ""),
      nombre: String(c.nombre ?? ""),
      nit: String(c.nit ?? ""),
    }))
    .filter((c) => c.id && c.nombre);
}

export async function fetchTramiteOptions(signal?: AbortSignal): Promise<TramiteOption[]> {
  const response = await fetch("/api/tramites", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new PagosApiError("Error al cargar tramites.", response.status);

  const payload: unknown = await response.json().catch(() => null);

  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (isRecord(payload)) {
    items = Array.isArray(payload.tramites)
      ? payload.tramites
      : Array.isArray(payload.data)
        ? payload.data
        : [];
  }

  return items
    .filter(isRecord)
    .map((t) => ({
      id: String(t.id ?? ""),
      consecutivo: String(t.consecutivo ?? t.doNumber ?? ""),
      clienteNombre: isRecord(t.cliente)
        ? String(t.cliente.nombre ?? "")
        : String(t.clienteNombre ?? ""),
    }))
    .filter((t) => t.id && t.consecutivo);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}
