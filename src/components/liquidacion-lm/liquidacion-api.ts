/**
 * Helpers de API para el módulo de Liquidación LM (cuenta Lucho).
 * Todos los montos llegan como string (BigInt serializado desde Prisma).
 */

export type LiquidacionTramiteRow = {
  facturaId: string;
  borradorId: string;
  tramiteId: string;
  consecutivo: string;
  clienteNombre: string;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  saldoLMInterno: string; // BigInt as string
  saldoAFavorCliente: string; // BigInt as string
  saldoLM: string; // BigInt as string; <0 Lucho debe; >0 Galcomex debe
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

/** Formatea BigInt serializado como COP: $45.226.000 (negativos con signo). */
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

export function formatDate(isoString: string | null): string {
  if (!isoString) return "—";
  try {
    return new Date(isoString).toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "America/Bogota",
    });
  } catch {
    return isoString;
  }
}
