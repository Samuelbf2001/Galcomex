/**
 * Helpers de API para el módulo de Dashboard.
 * Todos los montos llegan como string (BigInt serializado).
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type DosPorEstado = {
  estado: string;
  count: number;
};

export type PendienteFacturarRow = {
  id: string;
  consecutivo: string;
  clienteNombre: string;
  estado: string;
  fechaRef: string | null;
  dias: number;
  alerta: boolean;
};

export type CarteraVencidaRow = {
  id: string;
  numSiigo: string;
  clienteNombre: string;
  saldoACargoCliente: string;
  fechaFactura: string;
  diasAntiguedad: number;
};

export type AnticiposConSaldoResumen = {
  cantidad: number;
  totalRestante: string;
};

export type ActividadRecienteRow = {
  id: string;
  accion: string;
  entidad: string;
  entidadId: string;
  usuarioNombre: string;
  createdAt: string;
};

export type DashboardApiData = {
  dosActivos: number;
  dosPorEstado: DosPorEstado[];
  pendientesFacturar: PendienteFacturarRow[];
  carteraVencida: CarteraVencidaRow[];
  totalCarteraVencida: string;
  anticiposConSaldo: AnticiposConSaldoResumen;
  actividadReciente: ActividadRecienteRow[];
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class DashboardApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
  }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const payload: unknown = await res.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // ignore
  }
  return `Error ${res.status}`;
}

function mapDosPorEstado(raw: unknown[]): DosPorEstado[] {
  return raw.filter(isRecord).map((r) => ({
    estado: String(r.estado ?? ""),
    count: typeof r.count === "number" ? r.count : 0,
  }));
}

function mapPendienteRow(r: Record<string, unknown>): PendienteFacturarRow {
  return {
    id: String(r.id ?? ""),
    consecutivo: String(r.consecutivo ?? ""),
    clienteNombre: String(r.clienteNombre ?? ""),
    estado: String(r.estado ?? ""),
    fechaRef: typeof r.fechaRef === "string" ? r.fechaRef : null,
    dias: typeof r.dias === "number" ? r.dias : 0,
    alerta: Boolean(r.alerta),
  };
}

function mapCarteraVencidaRow(r: Record<string, unknown>): CarteraVencidaRow {
  return {
    id: String(r.id ?? ""),
    numSiigo: String(r.numSiigo ?? ""),
    clienteNombre: String(r.clienteNombre ?? ""),
    saldoACargoCliente: String(r.saldoACargoCliente ?? "0"),
    fechaFactura: String(r.fechaFactura ?? ""),
    diasAntiguedad: typeof r.diasAntiguedad === "number" ? r.diasAntiguedad : 0,
  };
}

function mapActividadRow(r: Record<string, unknown>): ActividadRecienteRow {
  return {
    id: String(r.id ?? ""),
    accion: String(r.accion ?? ""),
    entidad: String(r.entidad ?? ""),
    entidadId: String(r.entidadId ?? ""),
    usuarioNombre: String(r.usuarioNombre ?? ""),
    createdAt: String(r.createdAt ?? ""),
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function fetchDashboard(
  signal?: AbortSignal,
): Promise<DashboardApiData> {
  let res: Response;
  try {
    res = await fetch("/api/dashboard", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new DashboardApiError(
      "No fue posible conectar con /api/dashboard.",
    );
  }

  if (!res.ok) {
    const msg = await parseErrorMessage(res);
    throw new DashboardApiError(msg, res.status);
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new DashboardApiError("Respuesta del dashboard no válida.");
  }

  const anticipos = isRecord(payload.anticiposConSaldo)
    ? payload.anticiposConSaldo
    : {};

  return {
    dosActivos:
      typeof payload.dosActivos === "number" ? payload.dosActivos : 0,
    dosPorEstado: Array.isArray(payload.dosPorEstado)
      ? mapDosPorEstado(payload.dosPorEstado)
      : [],
    pendientesFacturar: Array.isArray(payload.pendientesFacturar)
      ? payload.pendientesFacturar.filter(isRecord).map(mapPendienteRow)
      : [],
    carteraVencida: Array.isArray(payload.carteraVencida)
      ? payload.carteraVencida.filter(isRecord).map(mapCarteraVencidaRow)
      : [],
    totalCarteraVencida: String(payload.totalCarteraVencida ?? "0"),
    anticiposConSaldo: {
      cantidad:
        typeof anticipos.cantidad === "number" ? anticipos.cantidad : 0,
      totalRestante: String(anticipos.totalRestante ?? "0"),
    },
    actividadReciente: Array.isArray(payload.actividadReciente)
      ? payload.actividadReciente.filter(isRecord).map(mapActividadRow)
      : [],
  };
}

// ─── Utilidades de formato ────────────────────────────────────────────────────

/** Formatea BigInt serializado como COP: $45.226.000 */
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

/** Formatea una fecha ISO como dd/mm/aaaa */
export function formatDate(isoString: string | null): string {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "America/Bogota",
    });
  } catch {
    return isoString;
  }
}

/** Etiqueta legible del estado del DO */
export function labelEstado(estado: string): string {
  const mapa: Record<string, string> = {
    SOLICITUD: "Solicitud",
    APERTURA: "Apertura",
    EN_TRAMITE: "En trámite",
    EN_PUERTO: "En puerto",
    DESPACHADO: "Despachado",
    ENVIADO_A_FACTURAR: "Env. a facturar",
    FACTURADO: "Facturado",
    PAGADO: "Pagado",
    CERRADO: "Cerrado",
  };
  return mapa[estado] ?? estado;
}
