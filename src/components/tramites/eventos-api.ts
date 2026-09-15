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

export type PropuestaTarifaRow = {
  tarifario: { id: string; nombre: string; version: number; alcance: string; vigenteDesde: string; vigenteHasta: string } | null;
  motivo: string | null;
  resultado: {
    lineas: LineaPropuestaRow[];
    pendientes: { concepto: string; nombrePublico: string; motivo: string }[];
    manuales: { concepto: string; nombrePublico: string }[];
    total: string;
    totalConIva: string;
  } | null;
  contexto: AtributosTramite & { eventos: { codigo: string; cantidad: number }[] };
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
            ? r.pendientes.filter(isRecord).map((x) => ({ concepto: str(x.concepto), nombrePublico: str(x.nombrePublico), motivo: str(x.motivo) }))
            : [],
          manuales: Array.isArray(r.manuales)
            ? r.manuales.filter(isRecord).map((x) => ({ concepto: str(x.concepto), nombrePublico: str(x.nombrePublico) }))
            : [],
          total: str(r.total, "0"),
          totalConIva: str(r.totalConIva, "0"),
        }
      : null,
    contexto: normalizeContexto(p.contexto),
  };
}
