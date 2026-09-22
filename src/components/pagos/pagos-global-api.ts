/**
 * Helpers de API para el módulo GLOBAL de pagos (vista transversal de todos los DOs).
 * La creación/edición/borrado reutiliza los endpoints por-DO de pagos-api.ts.
 * BigInt serializado como string desde el backend — parsear con BigInt().
 */

import type { CanalPago, GrupoPagoDOInfo } from "@/components/pagos/pagos-api";

export type {
  CanalPago,
  CreatePagoInput,
  GrupoPagoDOInfo,
  PagoComprobanteCategoria,
  UpdatePagoInput,
} from "@/components/pagos/pagos-api";
export {
  CANALES_PAGO,
  PagosApiError,
  createPago,
  updatePago,
  deletePago,
  formatCOP,
  subirComprobante,
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
  /** Nombres de beneficiarios vinculados (display). */
  beneficiarios: string;
  numSoporte: string | null;
  /** Comprobante bancario (Bancolombia). null = sin comprobante (badge de advertencia, no bloquea). */
  documentoId: string | null;
  /** Id del grupo de pago multi-DO (null = pago normal de un solo DO). */
  grupoPagoId: string | null;
  /** Otros DOs del mismo grupoPagoId (vacío si no es un pago multi-DO). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
  valor: string; // BigInt serializado
  canalPago: CanalPago;
  costoBancario: string; // BigInt serializado
  orden: number;
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
    beneficiarios: (() => {
      const arr = Array.isArray(raw.beneficiarios) ? raw.beneficiarios : [];
      return arr
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((link) => {
          const b = typeof link.beneficiario === "object" && link.beneficiario !== null
            ? (link.beneficiario as Record<string, unknown>)
            : link;
          return typeof b.nombre === "string" ? b.nombre : "";
        })
        .filter(Boolean)
        .join(", ");
    })(),
    numSoporte: typeof raw.numSoporte === "string" ? raw.numSoporte : null,
    documentoId: typeof raw.documentoId === "string" ? raw.documentoId : null,
    grupoPagoId: typeof raw.grupoPagoId === "string" ? raw.grupoPagoId : null,
    grupoOtrosDOs: (() => {
      const arr = Array.isArray(raw.grupoOtrosDOs) ? raw.grupoOtrosDOs : [];
      return arr
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((g) => ({
          tramiteId: String(g.tramiteId ?? ""),
          consecutivo: String(g.consecutivo ?? ""),
        }));
    })(),
    valor: String(raw.valor ?? "0"),
    canalPago: (raw.canalPago as CanalPago) ?? "OTRO",
    costoBancario: String(raw.costoBancario ?? "0"),
    orden: typeof raw.orden === "number" ? raw.orden : 0,
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

/** Máximo que admite `GET /api/tramites?take=` para los selectores de DO. */
const TRAMITE_OPTIONS_TAKE = 200;

/**
 * Opciones de DO para los selectores (nuevo pago, multi-DO). Pide `take=200`
 * porque sin `take` el API recorta a 50 en silencio; si el servidor aún no
 * admite ese máximo (400 de validación) reintenta con 100.
 */
export async function fetchTramiteOptions(signal?: AbortSignal): Promise<TramiteOption[]> {
  let response = await fetch(`/api/tramites?take=${TRAMITE_OPTIONS_TAKE}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (response.status === 400) {
    response = await fetch("/api/tramites?take=100", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  }
  if (!response.ok) throw new PagosApiError("Error al cargar trámites.", response.status);

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

// ─────────────────────────────────────────────────────────────────────────────
// Pago multi-DO (caso Karina/Occidente) — POST /api/pagos/multi
// ─────────────────────────────────────────────────────────────────────────────

/** Una FacturaProveedor REGISTRADA de un beneficiario, con datos de su DO. */
export type FacturaElegibleMultiDORow = {
  id: string;
  numFactura: string;
  valor: string; // BigInt serializado
  fecha: string; // ISO
  tramiteId: string;
  tramiteConsecutivo: string;
  clienteId: string;
  clienteNombre: string;
  /** false = el DO no tiene anticipo aplicado; la UI debe marcarlo (regla "sin anticipo no hay pagos"). */
  tieneAnticipoAplicado: boolean;
};

/** Lista TODAS las FacturaProveedor REGISTRADA de un beneficiario, de todos los DOs. */
export async function fetchFacturasElegiblesMultiDO(
  beneficiarioId: string,
  signal?: AbortSignal,
): Promise<FacturaElegibleMultiDORow[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/pagos/multi?beneficiarioId=${encodeURIComponent(beneficiarioId)}`,
      { cache: "no-store", headers: { Accept: "application/json" }, signal },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con /api/pagos/multi.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  const rawFacturas = isRecord(payload) && Array.isArray(payload.facturas) ? payload.facturas : [];

  return rawFacturas.filter(isRecord).map((f) => ({
    id: String(f.id ?? ""),
    numFactura: String(f.numFactura ?? ""),
    valor: String(f.valor ?? "0"),
    fecha: typeof f.fecha === "string" ? f.fecha : "",
    tramiteId: String(f.tramiteId ?? ""),
    tramiteConsecutivo: String(f.tramiteConsecutivo ?? ""),
    clienteId: String(f.clienteId ?? ""),
    clienteNombre: String(f.clienteNombre ?? ""),
    tieneAnticipoAplicado: f.tieneAnticipoAplicado === true,
  }));
}

export type CrearPagoMultiDOInput = {
  beneficiarioId: string;
  facturas: { facturaProveedorId: string; monto: string }[];
  canalPago: CanalPago;
  fechaRealPago?: string | null;
  concepto?: string;
  documentoId?: string | null;
  comprobanteComercioId?: string | null;
  bancoBeneficiarioId?: string | null;
};

export type PagoMultiDOCreado = {
  id: string;
  tramiteId: string;
  valor: string;
  costoBancario: string;
};

export type CrearPagoMultiDOResult = {
  grupoPagoId: string;
  pagos: PagoMultiDOCreado[];
};

/** Crea el pago multi-DO — ver crearPagoMultiDO() en src/lib/pagos/service.ts. */
export async function crearPagoMultiDO(
  input: CrearPagoMultiDOInput,
): Promise<CrearPagoMultiDOResult> {
  const response = await fetch("/api/pagos/multi", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible crear el pago multi-DO (${response.status}).`;
    throw new PagosApiError(message, response.status);
  }

  if (!isRecord(payload) || typeof payload.grupoPagoId !== "string" || !Array.isArray(payload.pagos)) {
    throw new PagosApiError("Respuesta de pago multi-DO no válida.");
  }

  return {
    grupoPagoId: payload.grupoPagoId,
    pagos: payload.pagos.filter(isRecord).map((p) => ({
      id: String(p.id ?? ""),
      tramiteId: String(p.tramiteId ?? ""),
      valor: String(p.valor ?? "0"),
      costoBancario: String(p.costoBancario ?? "0"),
    })),
  };
}
