/**
 * Helpers de API para el módulo de Facturación (borradores + transiciones).
 * Patrón idéntico a pagos-api.ts.
 * BigInt serializado como string desde el backend — parsear con BigInt().
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type EstadoBorrador = "BORRADOR" | "EN_REVISION" | "APROBADO" | "FACTURADO";

export type LineaRevisionRow = {
  id: string;
  borradorId: string;
  concepto: string;
  numSoporte: string | null;
  valor: string; // BigInt serializado
  orden: number;
  observacion: string | null;
  origen: "AUTO" | "MANUAL";
  /** IDs de facturas de proveedor vinculadas (pivot N↔N). */
  facturasVinculadas: string[];
};

/** Un concepto operacional: nombre + valor (BigInt como string) */
export type ConceptoOperacionalRow = {
  concepto: string;
  valor: string; // BigInt serializado
};

export type BorradorRow = {
  id: string;
  tramiteId: string;
  comision: string; // BigInt
  ivaComision: string; // BigInt
  impuesto4x1000: string; // BigInt
  costosBancarios: string; // BigInt
  totalAnticipo: string; // BigInt
  totalPagos: string; // BigInt
  totalFactura: string; // BigInt
  saldoAFavorCliente: string; // BigInt
  saldoACargoCliente: string; // BigInt
  saldoAFavorLM: string; // BigInt
  saldoACargoLM: string; // BigInt
  /** Total retenciones (RETE IVA + RETE FTE + RETE ICA). Fallback "0". */
  retenciones: string; // BigInt
  /** Total por líneas (Σ líneas + comisión + IVA − retenciones). BigInt. */
  totalFacturaLineas: string; // BigInt
  /** Desglose de conceptos operacionales de la comisión. Null si no aplica. */
  conceptosOperacionales: ConceptoOperacionalRow[] | null;
  estado: EstadoBorrador;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  fechaAprobacion: string | null;
  createdAt: string;
  lineasRevision: LineaRevisionRow[];
  factura: FacturaRow | null;
};

export type FacturaRow = {
  id: string;
  borradorId: string;
  numSiigo: string;
  fecha: string;
  totalFactura: string; // BigInt
};

export type TramiteParaFacturacion = {
  id: string;
  consecutivo: string;
  estado: string;
  eta: string | null;
  cliente: {
    id: string;
    nombre: string;
    nit: string;
  };
  borradores: BorradorRow[];
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class FacturacionApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FacturacionApiError";
    this.status = status;
  }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

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

function normalizeLinea(raw: Record<string, unknown>): LineaRevisionRow {
  const facturasVinculadas: string[] = Array.isArray(raw.facturas)
    ? (raw.facturas as unknown[])
        .filter(isRecord)
        .map((f) => String(f.facturaId ?? ""))
        .filter((id) => id !== "")
    : [];

  return {
    id: String(raw.id ?? ""),
    borradorId: String(raw.borradorId ?? ""),
    concepto: String(raw.concepto ?? ""),
    numSoporte: typeof raw.numSoporte === "string" ? raw.numSoporte : null,
    valor: String(raw.valor ?? "0"),
    orden: typeof raw.orden === "number" ? raw.orden : 0,
    observacion: typeof raw.observacion === "string" ? raw.observacion : null,
    origen: raw.origen === "MANUAL" ? "MANUAL" : "AUTO",
    facturasVinculadas,
  };
}

function normalizeFactura(raw: Record<string, unknown>): FacturaRow {
  return {
    id: String(raw.id ?? ""),
    borradorId: String(raw.borradorId ?? ""),
    numSiigo: String(raw.numSiigo ?? ""),
    fecha: String(raw.fecha ?? ""),
    totalFactura: String(raw.totalFactura ?? "0"),
  };
}

function normalizeConceptos(raw: unknown): ConceptoOperacionalRow[] | null {
  if (!Array.isArray(raw)) return null;
  const result: ConceptoOperacionalRow[] = [];
  for (const item of raw) {
    if (isRecord(item) && typeof item.concepto === "string") {
      result.push({ concepto: item.concepto, valor: String(item.valor ?? "0") });
    }
  }
  return result.length > 0 ? result : null;
}

function normalizeBorrador(raw: Record<string, unknown>): BorradorRow {
  const lineas = Array.isArray(raw.lineasRevision)
    ? (raw.lineasRevision as unknown[]).filter(isRecord).map(normalizeLinea)
    : [];
  const factura =
    isRecord(raw.factura) ? normalizeFactura(raw.factura) : null;

  return {
    id: String(raw.id ?? ""),
    tramiteId: String(raw.tramiteId ?? ""),
    comision: String(raw.comision ?? "0"),
    ivaComision: String(raw.ivaComision ?? "0"),
    impuesto4x1000: String(raw.impuesto4x1000 ?? "0"),
    costosBancarios: String(raw.costosBancarios ?? "0"),
    totalAnticipo: String(raw.totalAnticipo ?? "0"),
    totalPagos: String(raw.totalPagos ?? "0"),
    totalFactura: String(raw.totalFactura ?? "0"),
    saldoAFavorCliente: String(raw.saldoAFavorCliente ?? "0"),
    saldoACargoCliente: String(raw.saldoACargoCliente ?? "0"),
    saldoAFavorLM: String(raw.saldoAFavorLM ?? "0"),
    saldoACargoLM: String(raw.saldoACargoLM ?? "0"),
    retenciones: String(raw.retenciones ?? "0"),
    totalFacturaLineas: String(raw.totalFacturaLineas ?? "0"),
    conceptosOperacionales: normalizeConceptos(raw.conceptosOperacionales),
    estado: (raw.estado as EstadoBorrador) ?? "BORRADOR",
    numFacturaSiigo: typeof raw.numFacturaSiigo === "string" ? raw.numFacturaSiigo : null,
    fechaFactura: typeof raw.fechaFactura === "string" ? raw.fechaFactura : null,
    fechaAprobacion: typeof raw.fechaAprobacion === "string" ? raw.fechaAprobacion : null,
    createdAt: String(raw.createdAt ?? ""),
    lineasRevision: lineas,
    factura,
  };
}

// ─── Tramites con borradores ──────────────────────────────────────────────────

export async function fetchTramitesParaFacturacion(
  signal?: AbortSignal,
): Promise<TramiteParaFacturacion[]> {
  let response: Response;
  try {
    response = await fetch("/api/tramites?take=100", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new FacturacionApiError("No fue posible conectar con /api/tramites.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new FacturacionApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.tramites)) {
    throw new FacturacionApiError("Respuesta de trámites no válida.");
  }

  const ESTADOS_FACTURABLES = ["ENVIADO_A_FACTURAR", "FACTURADO", "PAGADO", "CERRADO"];

  return (payload.tramites as unknown[]).filter(isRecord).filter(
    (t) => ESTADOS_FACTURABLES.includes(String(t.estado ?? "")),
  ).map(
    (t): TramiteParaFacturacion => {
      const cliente = isRecord(t.cliente) ? t.cliente : {};
      return {
        id: String(t.id ?? ""),
        consecutivo: String(t.consecutivo ?? ""),
        estado: String(t.estado ?? ""),
        eta: typeof t.eta === "string" ? t.eta : null,
        cliente: {
          id: String(cliente.id ?? ""),
          nombre: String(cliente.nombre ?? ""),
          nit: String(cliente.nit ?? ""),
        },
        borradores: [],
      };
    },
  );
}

export async function fetchBorradoresDeTramite(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<BorradorRow[]> {
  let response: Response;
  try {
    response = await fetch(`/api/tramites/${tramiteId}/borrador`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new FacturacionApiError("No fue posible conectar con la API de borradores.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new FacturacionApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.borradores)) {
    throw new FacturacionApiError("Respuesta de borradores no válida.");
  }

  return (payload.borradores as unknown[]).filter(isRecord).map(normalizeBorrador);
}

// ─── Generar borrador ─────────────────────────────────────────────────────────

export type GenerarBorradorInput = {
  comision?: string; // BigInt como string, opcional
  ivaComision?: string;
  montoLM?: string;
  /**
   * Total retenciones (RETE IVA + RETE FTE + RETE ICA).
   * DEUDA: el Zod schema del endpoint POST /borrador aún no acepta este campo.
   * Incluido aquí para que el frontend esté listo cuando WS-A lo agregue.
   */
  retenciones?: string;
  /**
   * Desglose de conceptos operacionales de la comisión.
   * DEUDA: el Zod schema del endpoint POST /borrador aún no acepta este campo.
   */
  conceptosOperacionales?: { concepto: string; valor: string }[];
};

export async function generarBorrador(
  tramiteId: string,
  input: GenerarBorradorInput,
): Promise<BorradorRow> {
  const body: Record<string, unknown> = {};
  if (input.comision) body.comision = input.comision;
  if (input.ivaComision) body.ivaComision = input.ivaComision;
  if (input.montoLM) body.montoLM = input.montoLM;
  // retenciones y conceptosOperacionales se incluyen cuando el backend los acepte
  if (input.retenciones) body.retenciones = input.retenciones;
  if (input.conceptosOperacionales) body.conceptosOperacionales = input.conceptosOperacionales;

  const response = await fetch(`/api/tramites/${tramiteId}/borrador`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al generar el borrador (${response.status}).`;
    throw new FacturacionApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.borrador)) {
    throw new FacturacionApiError("Respuesta de generación no válida.");
  }

  return normalizeBorrador(payload.borrador);
}

// ─── Transición de estado ─────────────────────────────────────────────────────

export type TransicionInput =
  | { nuevoEstado: "EN_REVISION" }
  | { nuevoEstado: "APROBADO" }
  | { nuevoEstado: "FACTURADO"; numFacturaSiigo: string; fechaFactura: string };

export async function transicionarBorrador(
  borradorId: string,
  input: TransicionInput,
): Promise<BorradorRow> {
  const response = await fetch(`/api/borradores/${borradorId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error en transición (${response.status}).`;
    throw new FacturacionApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.borrador)) {
    throw new FacturacionApiError("Respuesta de transición no válida.");
  }

  return normalizeBorrador(payload.borrador);
}

// ─── Líneas manuales ──────────────────────────────────────────────────────────

export type CrearLineaInput = {
  concepto: string;
  numSoporte?: string;
  valor: string; // BigInt como string
  observacion?: string;
  facturaIds?: string[];
};

export type ActualizarLineaInput = {
  concepto?: string;
  numSoporte?: string | null;
  valor?: string;
  observacion?: string | null;
  facturaIds?: string[];
};

async function parseBorradorResponse(response: Response): Promise<BorradorRow> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error (${response.status}).`;
    throw new FacturacionApiError(message, response.status);
  }
  if (!isRecord(payload) || !isRecord(payload.borrador)) {
    throw new FacturacionApiError("Respuesta de líneas no válida.");
  }
  return normalizeBorrador(payload.borrador);
}

export async function crearLineaManual(
  borradorId: string,
  input: CrearLineaInput,
): Promise<BorradorRow> {
  const response = await fetch(`/api/borradores/${borradorId}/lineas`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  return parseBorradorResponse(response);
}

export async function actualizarLinea(
  borradorId: string,
  lineaId: string,
  input: ActualizarLineaInput,
): Promise<BorradorRow> {
  const response = await fetch(`/api/borradores/${borradorId}/lineas/${lineaId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  return parseBorradorResponse(response);
}

export async function eliminarLinea(
  borradorId: string,
  lineaId: string,
): Promise<BorradorRow> {
  const response = await fetch(`/api/borradores/${borradorId}/lineas/${lineaId}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  return parseBorradorResponse(response);
}

// ─── Export SIIGO ───────────────────────────────────────────────────────────────

/**
 * URL del archivo de importación de facturas de venta de SIIGO Nube (formato A–AE)
 * para un borrador. El endpoint exige rol ADMIN/REVISOR y lee los códigos contables
 * de variables de entorno (ver .env: SIIGO_IMPORT_*).
 */
export function urlSiigoImport(borradorId: string): string {
  return `/api/borradores/${borradorId}/siigo-import`;
}

/** Dispara la descarga del XLSX de importación SIIGO en el navegador. */
export function descargarSiigoImport(borradorId: string): void {
  const a = document.createElement("a");
  a.href = urlSiigoImport(borradorId);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ─── Formateo ─────────────────────────────────────────────────────────────────

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
    if (v < 0n) return null;
    return v.toString();
  } catch {
    return null;
  }
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export const ESTADO_BORRADOR_LABEL: Record<EstadoBorrador, string> = {
  BORRADOR: "Borrador",
  EN_REVISION: "En revisión",
  APROBADO: "Aprobado",
  FACTURADO: "Facturado",
};

export function estadoBorradorColorClass(estado: EstadoBorrador): string {
  switch (estado) {
    case "BORRADOR":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "EN_REVISION":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "APROBADO":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "FACTURADO":
      return "border-cyan-200 bg-cyan-50 text-cyan-700";
  }
}
