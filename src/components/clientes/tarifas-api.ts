/**
 * Cliente HTTP del tarifario por empresa (M2). Mismo estilo defensivo que
 * `capacidades-api.ts`: nunca se confía en la forma del JSON.
 */

export type TipoCalculoTarifa =
  | "FIJO"
  | "POR_UNIDAD"
  | "PORCENTAJE_MIN"
  | "PRIMERO_MAS_ADICIONAL"
  | "ESPEJO_DE_COSTO"
  | "POR_TRAMO";
export type DisparadorTarifa = "SIEMPRE" | "EVENTO" | "MANUAL";
export type UnidadTarifa = "TRAMITE" | "CONTENEDOR" | "DECLARACION" | "DOCUMENTO" | "ITEM" | "MES";
export type EstadoTarifario = "BORRADOR" | "VIGENTE" | "VENCIDO" | "REEMPLAZADO";

export const TIPOS_CALCULO: { value: TipoCalculoTarifa; label: string; ayuda: string }[] = [
  { value: "FIJO", label: "Fijo", ayuda: "Mismo valor en todo trámite (gastos de trámite por embarque)." },
  { value: "POR_UNIDAD", label: "Por unidad", ayuda: "Valor × cantidad: por declaración, contenedor, documento, ítem o mes." },
  { value: "PORCENTAJE_MIN", label: "% sobre CIF con mínimo", ayuda: "Porcentaje sobre el valor en aduana, con mínimo por tipo de carga (CW: 0,37 %)." },
  { value: "PRIMERO_MAS_ADICIONAL", label: "Primero + adicionales", ayuda: "El primero a un precio y cada adicional a otro (clasificación: 380.000 + 180.000)." },
  { value: "ESPEJO_DE_COSTO", label: "Espejo de un costo", ayuda: "Se cobra lo mismo que costó (pago del registro VUCE)." },
  { value: "POR_TRAMO", label: "Por escalas de volumen", ayuda: "El precio de cada unidad depende de en qué escala caiga la cantidad total (Polyrec ZF: 1 contenedor 300.000; 2 o más, 250.000 cada uno)." },
];

export const DISPARADORES: { value: DisparadorTarifa; label: string }[] = [
  { value: "SIEMPRE", label: "Siempre" },
  { value: "EVENTO", label: "Solo si pasó el evento" },
  { value: "MANUAL", label: "A mano" },
];

export const UNIDADES: { value: UnidadTarifa; label: string }[] = [
  { value: "TRAMITE", label: "Trámite" },
  { value: "CONTENEDOR", label: "Contenedor" },
  { value: "DECLARACION", label: "Declaración" },
  { value: "DOCUMENTO", label: "Documento" },
  { value: "ITEM", label: "Ítem" },
  { value: "MES", label: "Mes" },
];

export const ALCANCES: { value: string; label: string }[] = [
  { value: "TRAMITE", label: "Trámites de importación" },
  { value: "CLASIFICACION", label: "Clasificación arancelaria" },
  { value: "PLAN_VALLEJO", label: "Plan Vallejo" },
  { value: "EXPORTACION", label: "Exportaciones" },
  { value: "OTROS", label: "Otros servicios" },
];

export type MinimosTarifa = { SUELTA?: string; CONTENEDOR_20?: string; CONTENEDOR_40?: string };
export type TramoTarifa = { hasta: number | null; valor: string };

export type TarifaItemRow = {
  id: string;
  orden: number;
  concepto: string;
  nombrePublico: string;
  siigoCodigo: string | null;
  tipoCalculo: TipoCalculoTarifa;
  disparador: DisparadorTarifa;
  eventoCodigo: string | null;
  unidad: UnidadTarifa;
  valor: string;
  valorAdicional: string | null;
  porcentajeBps: number | null;
  minimos: MinimosTarifa | null;
  conceptoCosto: string | null;
  tramos: TramoTarifa[] | null;
  aplicaIva: boolean;
  notas: string | null;
};

export type TarifarioRow = {
  id: string;
  empresaId: string;
  nombre: string;
  alcance: string;
  vigenteDesde: string;
  vigenteHasta: string;
  estado: EstadoTarifario;
  version: number;
  notas: string | null;
  creadoPor: string;
  createdAt: string;
  items: TarifaItemRow[];
};

/** Lo que manda el formulario de ítem (dinero como string de dígitos). */
export type TarifaItemForm = {
  concepto: string;
  nombrePublico: string;
  siigoCodigo?: string | null;
  tipoCalculo: TipoCalculoTarifa;
  disparador: DisparadorTarifa;
  eventoCodigo?: string | null;
  unidad: UnidadTarifa;
  valor: string;
  valorAdicional?: string | null;
  porcentajeBps?: number | null;
  minimos?: MinimosTarifa | null;
  conceptoCosto?: string | null;
  tramos?: TramoTarifa[] | null;
  aplicaIva: boolean;
  notas?: string | null;
  orden: number;
};

export type PlantillaRow = {
  codigo: string;
  /** Empresa cuya propuesta es esta plantilla (B2: "Litoplas", "CW Asia"…). */
  cliente: string;
  nombre: string;
  descripcion: string;
  alcance: string;
  fuente: string;
  items: number;
};

/** Fila ligera de `GET /api/tarifarios` — para "Copiar la tarifa de otra empresa" (B2). */
export type TarifarioLigero = {
  id: string;
  empresaId: string;
  empresaNombre: string;
  nombre: string;
  alcance: string;
  version: number;
  estado: EstadoTarifario;
  items: number;
};

export type EventoCatalogoRow = {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  documentosRequeridos: string[];
  permiteCantidad: boolean;
};

export type DetalleValidacion = { campo: string; mensaje: string };

export class TarifasApiError extends Error {
  status?: number;
  details?: DetalleValidacion[];

  constructor(message: string, status?: number, details?: DetalleValidacion[]) {
    super(message);
    this.name = "TarifasApiError";
    this.status = status;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;
}

function normalizeMinimos(v: unknown): MinimosTarifa | null {
  if (!isRecord(v)) return null;
  const out: MinimosTarifa = {};
  for (const k of ["SUELTA", "CONTENEDOR_20", "CONTENEDOR_40"] as const) {
    const raw = v[k];
    if (typeof raw === "string" && raw) out[k] = raw;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeItem(row: unknown): TarifaItemRow | null {
  if (!isRecord(row) || typeof row.id !== "string") return null;
  return {
    id: row.id,
    orden: typeof row.orden === "number" ? row.orden : 0,
    concepto: str(row.concepto),
    nombrePublico: str(row.nombrePublico),
    siigoCodigo: strOrNull(row.siigoCodigo),
    tipoCalculo: str(row.tipoCalculo, "FIJO") as TipoCalculoTarifa,
    disparador: str(row.disparador, "SIEMPRE") as DisparadorTarifa,
    eventoCodigo: strOrNull(row.eventoCodigo),
    unidad: str(row.unidad, "TRAMITE") as UnidadTarifa,
    valor: str(row.valor, "0"),
    valorAdicional: strOrNull(row.valorAdicional),
    porcentajeBps: typeof row.porcentajeBps === "number" ? row.porcentajeBps : null,
    minimos: normalizeMinimos(row.minimos),
    conceptoCosto: strOrNull(row.conceptoCosto),
    tramos: normalizeTramos(row.tramos),
    aplicaIva: row.aplicaIva !== false,
    notas: strOrNull(row.notas),
  };
}

function normalizeTramos(v: unknown): TramoTarifa[] | null {
  if (!Array.isArray(v)) return null;
  const out: TramoTarifa[] = [];
  for (const t of v) {
    if (!isRecord(t)) continue;
    const valor = str(t.valor);
    if (!/^\d+$/.test(valor)) continue;
    const hasta = t.hasta === null ? null : typeof t.hasta === "number" ? t.hasta : null;
    out.push({ hasta, valor });
  }
  return out.length ? out.sort((a, b) => (a.hasta ?? Infinity) - (b.hasta ?? Infinity)) : null;
}

function normalizeTarifario(row: unknown): TarifarioRow | null {
  if (!isRecord(row) || typeof row.id !== "string") return null;
  const creadoPor = isRecord(row.creadoPor) ? str(row.creadoPor.name) : "";
  const items = Array.isArray(row.items)
    ? row.items.map(normalizeItem).filter((i): i is TarifaItemRow => i !== null)
    : [];
  return {
    id: row.id,
    empresaId: str(row.empresaId),
    nombre: str(row.nombre),
    alcance: str(row.alcance, "TRAMITE"),
    vigenteDesde: str(row.vigenteDesde),
    vigenteHasta: str(row.vigenteHasta),
    estado: str(row.estado, "BORRADOR") as EstadoTarifario,
    version: typeof row.version === "number" ? row.version : 1,
    notas: strOrNull(row.notas),
    creadoPor,
    createdAt: str(row.createdAt),
    items,
  };
}

async function parseError(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  let details: DetalleValidacion[] | undefined;
  try {
    const body: unknown = await res.json();
    if (isRecord(body)) {
      if (typeof body.error === "string") message = body.error;
      if (Array.isArray(body.details)) {
        details = body.details
          .filter(isRecord)
          .map((d) => ({ campo: str(d.campo ?? d.path), mensaje: str(d.mensaje ?? d.message) }));
        if (message === fallback && details.length) message = details.map((d) => d.mensaje).join(" · ");
      }
    }
  } catch {
    /* sin cuerpo */
  }
  throw new TarifasApiError(message, res.status, details);
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new TarifasApiError("No fue posible conectar con el servidor.");
  }
  if (!res.ok) await parseError(res, `Error ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

function tarifarioDe(body: unknown): TarifarioRow {
  const t = isRecord(body) ? normalizeTarifario(body.tarifario) : null;
  if (!t) throw new TarifasApiError("Respuesta inesperada del servidor.");
  return t;
}

export async function fetchTarifarios(clienteId: string, signal?: AbortSignal): Promise<TarifarioRow[]> {
  const body = await request(`/api/clientes/${encodeURIComponent(clienteId)}/tarifarios`, { signal });
  const lista = isRecord(body) && Array.isArray(body.tarifarios) ? body.tarifarios : [];
  return lista.map(normalizeTarifario).filter((t): t is TarifarioRow => t !== null);
}

export type NuevoTarifarioForm = {
  plantilla?: string;
  /** Tarifario existente (de cualquier empresa) del que copiar los ítems. Mutuamente excluyente con `plantilla`. */
  origenTarifarioId?: string;
  nombre?: string;
  alcance?: string;
  vigenteDesde: string;
  vigenteHasta: string;
  notas?: string | null;
};

export async function crearTarifario(clienteId: string, form: NuevoTarifarioForm): Promise<TarifarioRow> {
  return tarifarioDe(
    await request(`/api/clientes/${encodeURIComponent(clienteId)}/tarifarios`, {
      method: "POST",
      body: JSON.stringify(form),
    }),
  );
}

export async function actualizarTarifario(
  id: string,
  form: { nombre?: string; alcance?: string; vigenteDesde?: string; vigenteHasta?: string; notas?: string | null },
): Promise<TarifarioRow> {
  return tarifarioDe(await request(`/api/tarifarios/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(form) }));
}

export async function eliminarTarifario(id: string): Promise<void> {
  await request(`/api/tarifarios/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function cambiarEstadoTarifario(id: string, estado: "VIGENTE" | "VENCIDO"): Promise<TarifarioRow> {
  return tarifarioDe(
    await request(`/api/tarifarios/${encodeURIComponent(id)}/estado`, { method: "POST", body: JSON.stringify({ estado }) }),
  );
}

export type DuplicarTarifarioForm = {
  nombre?: string;
  vigenteDesde: string;
  vigenteHasta: string;
  incrementoPct?: number;
  redondeoA?: number;
};

export async function duplicarTarifario(id: string, form: DuplicarTarifarioForm): Promise<TarifarioRow> {
  return tarifarioDe(
    await request(`/api/tarifarios/${encodeURIComponent(id)}/duplicar`, { method: "POST", body: JSON.stringify(form) }),
  );
}

export async function agregarItem(tarifarioId: string, item: TarifaItemForm): Promise<TarifarioRow> {
  return tarifarioDe(
    await request(`/api/tarifarios/${encodeURIComponent(tarifarioId)}/items`, { method: "POST", body: JSON.stringify(item) }),
  );
}

export async function actualizarItem(tarifarioId: string, itemId: string, item: Partial<TarifaItemForm>): Promise<TarifarioRow> {
  return tarifarioDe(
    await request(`/api/tarifarios/${encodeURIComponent(tarifarioId)}/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify(item),
    }),
  );
}

export async function eliminarItem(tarifarioId: string, itemId: string): Promise<TarifarioRow> {
  return tarifarioDe(
    await request(`/api/tarifarios/${encodeURIComponent(tarifarioId)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" }),
  );
}

export async function fetchPlantillas(signal?: AbortSignal): Promise<PlantillaRow[]> {
  const body = await request("/api/tarifarios/plantillas", { signal });
  const lista = isRecord(body) && Array.isArray(body.plantillas) ? body.plantillas : [];
  return lista.filter(isRecord).map((p) => ({
    codigo: str(p.codigo),
    cliente: str(p.cliente),
    nombre: str(p.nombre),
    descripcion: str(p.descripcion),
    alcance: str(p.alcance, "TRAMITE"),
    fuente: str(p.fuente),
    items: Array.isArray(p.items) ? p.items.length : 0,
  }));
}

function normalizeTarifarioLigero(row: unknown): TarifarioLigero | null {
  if (!isRecord(row) || typeof row.id !== "string") return null;
  return {
    id: row.id,
    empresaId: str(row.empresaId),
    empresaNombre: str(row.empresaNombre),
    nombre: str(row.nombre),
    alcance: str(row.alcance, "TRAMITE"),
    version: typeof row.version === "number" ? row.version : 1,
    estado: str(row.estado, "BORRADOR") as EstadoTarifario,
    items: typeof row.items === "number" ? row.items : 0,
  };
}

/** Catálogo ligero de tarifarios de TODAS las empresas, para "Copiar la tarifa de otra empresa" (B2). */
export async function fetchTarifariosLigero(
  excluirEmpresaId?: string,
  signal?: AbortSignal,
): Promise<TarifarioLigero[]> {
  const query = excluirEmpresaId ? `?excluirEmpresaId=${encodeURIComponent(excluirEmpresaId)}` : "";
  const body = await request(`/api/tarifarios${query}`, { signal });
  const lista = isRecord(body) && Array.isArray(body.tarifarios) ? body.tarifarios : [];
  return lista.map(normalizeTarifarioLigero).filter((t): t is TarifarioLigero => t !== null);
}

export async function fetchEventosCatalogo(signal?: AbortSignal): Promise<EventoCatalogoRow[]> {
  const body = await request("/api/eventos", { signal });
  const lista = isRecord(body) && Array.isArray(body.eventos) ? body.eventos : [];
  return lista.filter(isRecord).map((e) => ({
    codigo: str(e.codigo),
    nombre: str(e.nombre),
    descripcion: strOrNull(e.descripcion),
    documentosRequeridos: Array.isArray(e.documentosRequeridos)
      ? e.documentosRequeridos.filter((d): d is string => typeof d === "string")
      : [],
    permiteCantidad: e.permiteCantidad === true,
  }));
}

// ─── Presentación ─────────────────────────────────────────────────────────────

export function formatCOP(digits: string | null | undefined): string {
  if (!digits) return "$ 0";
  const neg = digits.startsWith("-");
  const clean = digits.replace(/^-/, "").replace(/\D/g, "") || "0";
  return `${neg ? "-" : ""}$ ${clean.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

export function formatFecha(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function etiquetaUnidad(unidad: UnidadTarifa): string {
  return UNIDADES.find((u) => u.value === unidad)?.label.toLowerCase() ?? unidad.toLowerCase();
}

/** Cómo se calcula el ítem, en una frase para la tabla. */
export function describirCalculo(item: TarifaItemRow): string {
  switch (item.tipoCalculo) {
    case "FIJO":
      return `${formatCOP(item.valor)} fijo`;
    case "POR_UNIDAD":
      return `${formatCOP(item.valor)} por ${etiquetaUnidad(item.unidad)}`;
    case "PORCENTAJE_MIN": {
      const pct = ((item.porcentajeBps ?? 0) / 100).toFixed(2).replace(".", ",");
      const mins = item.minimos
        ? [
            item.minimos.SUELTA ? `suelta ${formatCOP(item.minimos.SUELTA)}` : null,
            item.minimos.CONTENEDOR_20 ? `20′ ${formatCOP(item.minimos.CONTENEDOR_20)}` : null,
            item.minimos.CONTENEDOR_40 ? `40′ ${formatCOP(item.minimos.CONTENEDOR_40)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "";
      return `${pct} % sobre CIF${mins ? ` · mín. ${mins}` : ""}`;
    }
    case "PRIMERO_MAS_ADICIONAL":
      return `${formatCOP(item.valor)} el primer ${etiquetaUnidad(item.unidad)} + ${formatCOP(item.valorAdicional)} cada adicional`;
    case "ESPEJO_DE_COSTO":
      return `Lo que costó "${item.conceptoCosto ?? ""}"`;
    case "POR_TRAMO": {
      const tramos = item.tramos ?? [];
      return tramos
        .map((t, i) => {
          const anterior = i > 0 ? (tramos[i - 1]?.hasta ?? 0) : 0;
          const rango = t.hasta === null ? `${anterior + 1} o más` : t.hasta === 1 ? "1" : `${anterior + 1}–${t.hasta}`;
          return `${rango}: ${formatCOP(t.valor)} c/u`;
        })
        .join(" · ")
        .concat(` (por ${etiquetaUnidad(item.unidad)})`);
    }
  }
}

export function etiquetaEstado(estado: EstadoTarifario): string {
  switch (estado) {
    case "BORRADOR":
      return "Borrador";
    case "VIGENTE":
      return "Vigente";
    case "VENCIDO":
      return "Vencido";
    case "REEMPLAZADO":
      return "Reemplazado";
  }
}
