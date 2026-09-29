/**
 * Cliente HTTP de eventos del trámite y propuesta del tarifario (M3 + M2).
 */

export type EventoTramiteRow = {
  codigo: string;
  nombre: string;
  cantidad: number;
  observacion: string | null;
  marcadoPor: string;
  marcadoAt: string;
  documentosRequeridos: string[];
};

export type TipoCarga = "SUELTA" | "CONTENEDOR_20" | "CONTENEDOR_40";

export type AtributosTramite = {
  valorCif: string | null;
  tipoCarga: TipoCarga | null;
  numContenedores: number | null;
  numDeclaraciones: number | null;
  numDocumentos: number | null;
  numItems: number | null;
  /** Orden de compra del cliente (solo con `orden_compra_en_revision`). COP string. */
  ordenCompraNumero: string | null;
  ordenCompraValor: string | null;
  /** B1 — agencia de aduanas del DO y su agenciamiento estándar (`AGENCIAMIENTO_<AGENCIA>`). */
  agenciamiento?: { agencia: string | null; valor: string | null };
};

export type LineaPropuestaRow = {
  concepto: string;
  nombrePublico: string;
  siigoCodigo: string | null;
  cantidad: number;
  valorUnitario: string;
  valor: string;
  aplicaIva: boolean;
  origen: "SIEMPRE" | "EVENTO";
  detalle: string;
};

/**
 * Dónde se arregla un concepto que el tarifario no pudo calcular (espejo de
 * `CausaPendiente` en `lib/tarifas/motor.ts`). Sin dato → `BASE_DO`.
 */
export type CausaPendienteRow = "BASE_DO" | "COSTO_PROVEEDOR" | "TARIFARIO";

export type PendienteTarifaRow = {
  concepto: string;
  nombrePublico: string;
  motivo: string;
  causa?: CausaPendienteRow;
};

function causaPendiente(v: unknown): CausaPendienteRow {
  return v === "COSTO_PROVEEDOR" || v === "TARIFARIO" ? v : "BASE_DO";
}

/** Campos de la base de cálculo del DO (espejo de `CampoBaseTarifa` en `lib/tarifas/campos-tarifa.ts`). */
export type CampoBaseTarifa = "valorCif" | "tipoCarga" | "numContenedores" | "numDeclaraciones" | "numDocumentos" | "numItems";

/**
 * B2 — qué le pide la tarifa al DO: campos de la base de cálculo, códigos de los
 * eventos que cobra y si resta la agencia de aduanas. El panel de un DO de
 * «Otros» muestra solo esto.
 */
export type CamposTarifaRow = { base: CampoBaseTarifa[]; eventos: string[]; agencia: boolean };

export type PropuestaTarifaRow = {
  tarifario: { id: string; nombre: string; version: number; alcance: string; vigenteDesde: string; vigenteHasta: string } | null;
  motivo: string | null;
  /** La empresa tiene la función "Tarifario propio" (haya o no uno vigente). */
  tarifarioPropio?: boolean;
  resultado: {
    lineas: LineaPropuestaRow[];
    pendientes: PendienteTarifaRow[];
    manuales: { concepto: string; nombrePublico: string }[];
    total: string;
    totalConIva: string;
  } | null;
  contexto: AtributosTramite & { eventos: { codigo: string; cantidad: number }[] };
  /** B2 — solo cuando hay tarifa vigente; null/ausente = no hay tarifa (o respuesta vieja). */
  camposTarifa?: CamposTarifaRow | null;
};

export class EventosApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EventosApiError";
    this.status = status;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown, fb = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fb);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new EventosApiError("No fue posible conectar con el servidor.");
  }
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.error === "string") message = body.error;
      else if (isRecord(body) && Array.isArray(body.details)) {
        message = body.details
          .filter(isRecord)
          .map((d) => str(d.mensaje ?? d.message))
          .join(" · ");
      }
    } catch {
      /* sin cuerpo */
    }
    throw new EventosApiError(message, res.status);
  }
  return res.json();
}

function normalizeEvento(row: unknown): EventoTramiteRow | null {
  if (!isRecord(row) || typeof row.codigo !== "string") return null;
  return {
    codigo: row.codigo,
    nombre: str(row.nombre, row.codigo),
    cantidad: typeof row.cantidad === "number" ? row.cantidad : 1,
    observacion: strOrNull(row.observacion),
    marcadoPor: str(row.marcadoPor),
    marcadoAt: str(row.marcadoAt),
    documentosRequeridos: Array.isArray(row.documentosRequeridos) ? row.documentosRequeridos.filter((d): d is string => typeof d === "string") : [],
  };
}

export async function fetchEventosTramite(tramiteId: string, signal?: AbortSignal): Promise<EventoTramiteRow[]> {
  const body = await request(`/api/tramites/${encodeURIComponent(tramiteId)}/eventos`, { signal });
  const lista = isRecord(body) && Array.isArray(body.eventos) ? body.eventos : [];
  return lista.map(normalizeEvento).filter((e): e is EventoTramiteRow => e !== null);
}

export async function guardarEventosTramite(
  tramiteId: string,
  eventos: { codigo: string; cantidad: number; observacion?: string | null }[],
): Promise<EventoTramiteRow[]> {
  const body = await request(`/api/tramites/${encodeURIComponent(tramiteId)}/eventos`, { method: "PUT", body: JSON.stringify({ eventos }) });
  const lista = isRecord(body) && Array.isArray(body.eventos) ? body.eventos : [];
  return lista.map(normalizeEvento).filter((e): e is EventoTramiteRow => e !== null);
}

export async function guardarAtributosTramite(tramiteId: string, atributos: Partial<AtributosTramite>): Promise<void> {
  await request(`/api/tramites/${encodeURIComponent(tramiteId)}`, { method: "PATCH", body: JSON.stringify(atributos) });
}

/** B2 — agencia de aduanas del DO (la tarifa de «Otros» le resta su agenciamiento). Mismo PATCH del DO, con su AuditLog. */
export async function guardarAgenciaTramite(tramiteId: string, agenciaAduanas: string): Promise<void> {
  await request(`/api/tramites/${encodeURIComponent(tramiteId)}`, { method: "PATCH", body: JSON.stringify({ agenciaAduanas }) });
}

function normalizeContexto(v: unknown): PropuestaTarifaRow["contexto"] {
  const c = isRecord(v) ? v : {};
  const tipoCarga = str(c.tipoCarga);
  return {
    valorCif: strOrNull(c.valorCif),
    tipoCarga: tipoCarga === "SUELTA" || tipoCarga === "CONTENEDOR_20" || tipoCarga === "CONTENEDOR_40" ? tipoCarga : null,
    numContenedores: numOrNull(c.numContenedores),
    numDeclaraciones: numOrNull(c.numDeclaraciones),
    numDocumentos: numOrNull(c.numDocumentos),
    numItems: numOrNull(c.numItems),
    ordenCompraNumero: strOrNull(c.ordenCompraNumero),
    ordenCompraValor: strOrNull(c.ordenCompraValor),
    agenciamiento: isRecord(c.agenciamiento)
      ? { agencia: strOrNull(c.agenciamiento.agencia), valor: strOrNull(c.agenciamiento.valor) }
      : undefined,
    eventos: Array.isArray(c.eventos)
      ? c.eventos.filter(isRecord).map((e) => ({ codigo: str(e.codigo), cantidad: typeof e.cantidad === "number" ? e.cantidad : 1 }))
      : [],
  };
}

export async function fetchPropuestaTarifa(tramiteId: string, signal?: AbortSignal): Promise<PropuestaTarifaRow> {
  const body = await request(`/api/tramites/${encodeURIComponent(tramiteId)}/tarifa`, { signal });
  const p = isRecord(body) && isRecord(body.propuesta) ? body.propuesta : {};
  const t = isRecord(p.tarifario) ? p.tarifario : null;
  const r = isRecord(p.resultado) ? p.resultado : null;
  return {
    tarifario: t
      ? {
          id: str(t.id),
          nombre: str(t.nombre),
          version: typeof t.version === "number" ? t.version : 1,
          alcance: str(t.alcance, "TRAMITE"),
          vigenteDesde: str(t.vigenteDesde),
          vigenteHasta: str(t.vigenteHasta),
        }
      : null,
    motivo: strOrNull(p.motivo),
    tarifarioPropio: p.tarifarioPropio === true,
    resultado: r
      ? {
          lineas: Array.isArray(r.lineas)
            ? r.lineas.filter(isRecord).map((l) => ({
                concepto: str(l.concepto),
                nombrePublico: str(l.nombrePublico),
                siigoCodigo: strOrNull(l.siigoCodigo),
                cantidad: typeof l.cantidad === "number" ? l.cantidad : 1,
                valorUnitario: str(l.valorUnitario, "0"),
                valor: str(l.valor, "0"),
                aplicaIva: l.aplicaIva !== false,
                origen: l.origen === "EVENTO" ? "EVENTO" : "SIEMPRE",
                detalle: str(l.detalle),
              }))
            : [],
          pendientes: Array.isArray(r.pendientes)
            ? r.pendientes.filter(isRecord).map((x) => ({
                concepto: str(x.concepto),
                nombrePublico: str(x.nombrePublico),
                motivo: str(x.motivo),
                causa: causaPendiente(x.causa),
              }))
            : [],
          manuales: Array.isArray(r.manuales)
            ? r.manuales.filter(isRecord).map((x) => ({ concepto: str(x.concepto), nombrePublico: str(x.nombrePublico) }))
            : [],
          total: str(r.total, "0"),
          totalConIva: str(r.totalConIva, "0"),
        }
      : null,
    contexto: normalizeContexto(p.contexto),
    camposTarifa: normalizeCamposTarifa(p.camposTarifa),
  };
}

const CAMPOS_BASE_VALIDOS: readonly string[] = ["valorCif", "tipoCarga", "numContenedores", "numDeclaraciones", "numDocumentos", "numItems"];

function normalizeCamposTarifa(v: unknown): CamposTarifaRow | null {
  if (!isRecord(v)) return null;
  return {
    base: Array.isArray(v.base)
      ? v.base.filter((c): c is CampoBaseTarifa => typeof c === "string" && CAMPOS_BASE_VALIDOS.includes(c))
      : [],
    eventos: Array.isArray(v.eventos) ? v.eventos.filter((e): e is string => typeof e === "string") : [],
    agencia: v.agencia === true,
  };
}
