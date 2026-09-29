/**
 * Helpers de API para el módulo de Ingresos / Libro de bancos.
 * Consume GET /api/ingresos?clienteId=&desde=&hasta=
 * Dinero = pesos texto con 2 decimales, siempre ("45226000.00"), tal como lo
 * emite el servidor. Se lee con `centavosDeTextoApi` de `@/lib/dinero`.
 */

import type { CanalPago } from "@/components/pagos/pagos-api";
import { formatFechaCalendario } from "@/lib/tiempo/bogota";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type TipoIngreso = "ANTICIPO" | "ABONO" | "DEVOLUCION";

export type FilaIngreso = {
  id: string;
  tipo: TipoIngreso;
  referencia: string;
  /** DO vinculado (aplicación de anticipo o trámite de la factura). Null si no aplica. */
  tramiteId: string | null;
  /** Borrador de la factura de venta vinculada (solo ABONO/DEVOLUCION). */
  borradorId: string | null;
  montoConSigno: string;  // pesos texto (positivo = entrada, negativo = salida)
  monto: string;          // pesos texto (siempre positivo)
  canalPago: CanalPago | string;
  verificadoBanco: boolean;
  fecha: string;          // ISO
  clienteId: string;
  clienteNombre: string;
  saldoCorrido: string;   // pesos texto
};

export type IngresosData = {
  filas: FilaIngreso[];
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class IngresosApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "IngresosApiError";
    this.status = status;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const payload: unknown = await res.json();
    if (isRecord(payload) && typeof payload.error === "string") return payload.error;
  } catch {
    // ignore
  }
  return `Error ${res.status}`;
}

function mapFila(raw: unknown): FilaIngreso | null {
  if (!isRecord(raw)) return null;
  return {
    id: String(raw.id ?? ""),
    tipo: (raw.tipo as TipoIngreso) ?? "ABONO",
    referencia: String(raw.referencia ?? ""),
    tramiteId: typeof raw.tramiteId === "string" ? raw.tramiteId : null,
    borradorId: typeof raw.borradorId === "string" ? raw.borradorId : null,
    montoConSigno: String(raw.montoConSigno ?? "0"),
    monto: String(raw.monto ?? "0"),
    canalPago: String(raw.canalPago ?? ""),
    verificadoBanco: raw.verificadoBanco === true,
    fecha: String(raw.fecha ?? ""),
    clienteId: String(raw.clienteId ?? ""),
    clienteNombre: String(raw.clienteNombre ?? ""),
    saldoCorrido: String(raw.saldoCorrido ?? "0"),
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

export type FetchIngresosParams = {
  clienteId?: string;
  desde?: string;  // YYYY-MM-DD
  hasta?: string;  // YYYY-MM-DD
};

export async function fetchIngresos(
  params: FetchIngresosParams = {},
  signal?: AbortSignal,
): Promise<FilaIngreso[]> {
  const url = new URL("/api/ingresos", window.location.origin);
  if (params.clienteId) url.searchParams.set("clienteId", params.clienteId);
  if (params.desde) url.searchParams.set("desde", params.desde);
  if (params.hasta) url.searchParams.set("hasta", params.hasta);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new IngresosApiError("No fue posible conectar con /api/ingresos.");
  }

  if (!res.ok) {
    const msg = await parseErrorMessage(res);
    throw new IngresosApiError(msg, res.status);
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.ingresos)) {
    throw new IngresosApiError("Respuesta de ingresos no válida.");
  }

  return payload.ingresos
    .map(mapFila)
    .filter((f): f is FilaIngreso => f !== null);
}

// ─── Utilidades de formato ────────────────────────────────────────────────────
//
// Sin formateador local (D.1): las pantallas leen con `centavosDeTextoApi` y
// muestran con `formatoPesos`, ambos de `@/lib/dinero`.

/** Fecha-calendario (fecha del ingreso): día guardado a 00:00 UTC, se muestra en UTC. */
export function formatDate(isoString: string | null): string {
  if (!isoString) return "—";
  return formatFechaCalendario(isoString) || isoString;
}
