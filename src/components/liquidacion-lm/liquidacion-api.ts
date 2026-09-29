/**
 * Helpers de API para el módulo de Liquidación LM (cuenta Lucho).
 * Dinero = pesos texto con 2 decimales, siempre ("45226000.00"), tal como lo
 * emite el servidor. Se lee con `centavosDeTextoApi` de `@/lib/dinero`.
 */

import { formatFechaCalendario } from "@/lib/tiempo/bogota";

export type LiquidacionTramiteRow = {
  facturaId: string;
  borradorId: string;
  tramiteId: string;
  consecutivo: string;
  clienteId: string;
  clienteNombre: string;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  saldoLMInterno: string; // pesos texto
  saldoAFavorCliente: string; // pesos texto
  saldoLM: string; // pesos texto; <0 Lucho debe; >0 Galcomex debe
};

export type LiquidacionResumen = {
  saldoNeto: string;
  totalLuchoDebe: string;
  totalGalcomexDebe: string;
  cantidad: number;
};

export type LiquidacionData = {
  tramites: LiquidacionTramiteRow[];
  resumen: LiquidacionResumen;
};

export class LiquidacionApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LiquidacionApiError";
    this.status = status;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mapTramiteRow(t: Record<string, unknown>): LiquidacionTramiteRow {
  return {
    facturaId: String(t.facturaId ?? ""),
    borradorId: String(t.borradorId ?? ""),
    tramiteId: String(t.tramiteId ?? ""),
    consecutivo: String(t.consecutivo ?? ""),
    clienteId: String(t.clienteId ?? ""),
    clienteNombre: String(t.clienteNombre ?? ""),
    numFacturaSiigo:
      typeof t.numFacturaSiigo === "string" ? t.numFacturaSiigo : null,
    fechaFactura: typeof t.fechaFactura === "string" ? t.fechaFactura : null,
    saldoLMInterno: String(t.saldoLMInterno ?? "0"),
    saldoAFavorCliente: String(t.saldoAFavorCliente ?? "0"),
    saldoLM: String(t.saldoLM ?? "0"),
  };
}

export async function fetchLiquidacionLM(
  desde?: string,
  hasta?: string,
  signal?: AbortSignal,
): Promise<LiquidacionData> {
  const params = new URLSearchParams();
  if (desde) params.set("desde", desde);
  if (hasta) params.set("hasta", hasta);
  const qs = params.toString();
  const url = `/api/liquidacion-lm${qs ? `?${qs}` : ""}`;

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new LiquidacionApiError("No fue posible conectar con /api/liquidacion-lm.");
  }

  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const payload: unknown = await res.json();
      if (isRecord(payload) && typeof payload.error === "string") {
        msg = payload.error;
      }
    } catch {
      // ignore
    }
    throw new LiquidacionApiError(msg, res.status);
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.liquidacion)) {
    throw new LiquidacionApiError("Respuesta de liquidación no válida.");
  }

  const liq = payload.liquidacion;
  const rawTramites = Array.isArray(liq.tramites) ? liq.tramites : [];
  const resumen = isRecord(liq.resumen) ? liq.resumen : {};

  return {
    tramites: rawTramites.filter(isRecord).map(mapTramiteRow),
    resumen: {
      saldoNeto: String(resumen.saldoNeto ?? "0"),
      totalLuchoDebe: String(resumen.totalLuchoDebe ?? "0"),
      totalGalcomexDebe: String(resumen.totalGalcomexDebe ?? "0"),
      cantidad: typeof resumen.cantidad === "number" ? resumen.cantidad : 0,
    },
  };
}

// Sin formateador local (D.1): las pantallas leen con `centavosDeTextoApi` y
// muestran con `formatoPesos`, ambos de `@/lib/dinero`.

/** Fecha-calendario (fechaFactura): día guardado a 00:00 UTC, se muestra en UTC. */
export function formatDate(isoString: string | null): string {
  if (!isoString) return "—";
  return formatFechaCalendario(isoString) || isoString;
}
