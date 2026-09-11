export type TramiteRow = {
  id: string;
  doNumber: string;
  cliente: string;
  estado: string;
  ciudad: string;
  modalidad: string;
  referencia: string;
  fechaApertura: string;
  ultimoMovimiento: string;
  responsable: string;
  documentosPendientes: number | null;
};

export type ClienteOption = {
  id: string;
  nombre: string;
  nit: string;
  tipo: string;
};

export type FacturadoFilter = "todos" | "si" | "no";

export type TramiteFilters = {
  q?: string;
  estado?: string;
  ciudad?: string;
  clienteId?: string;
  tipoCliente?: string;
  facturado?: FacturadoFilter;
};

const allFilterValue = "todos";

/** Tamaño de página por defecto de la lista maestra (el API admite hasta 200). */
export const TRAMITES_PAGE_SIZE = 100;

export type TramitesPageOptions = {
  take?: number;
  skip?: number;
};

export type TramitesPage = {
  rows: TramiteRow[];
  /** Total de trámites que cumplen los filtros (para "Mostrando X de Y"). */
  total: number;
};

function buildTramitesQuery(filters?: TramiteFilters, page?: TramitesPageOptions): string {
  const params = new URLSearchParams();
  const q = filters?.q?.trim();

  if (page?.take !== undefined) {
    params.set("take", String(page.take));
  }

  if (page?.skip !== undefined && page.skip > 0) {
    params.set("skip", String(page.skip));
  }

  if (!filters) {
    const soloPagina = params.toString();
    return soloPagina ? `?${soloPagina}` : "";
  }

  if (q) {
    params.set("q", q);
  }

  if (filters.estado && filters.estado !== allFilterValue) {
    params.set("estado", filters.estado);
  }

  if (filters.ciudad && filters.ciudad !== allFilterValue) {
    params.set("ciudad", filters.ciudad);
  }

  if (filters.clienteId && filters.clienteId !== allFilterValue) {
    params.set("clienteId", filters.clienteId);
  }

  if (filters.tipoCliente && filters.tipoCliente !== allFilterValue) {
    params.set("tipoCliente", filters.tipoCliente);
  }

  if (filters.facturado && filters.facturado !== "todos") {
    params.set("facturado", filters.facturado === "si" ? "true" : "false");
  }

  const query = params.toString();

  return query ? `?${query}` : "";
}

export type TipoTramiteOption = {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  prefijoConsecutivo: string;
  requiereAgenciaAduanas: boolean;
  requiereEta: boolean;
  etiquetaReferenciaExterna: string | null;
};

/** Agencia fija de la empresa (capacidad regla_agencia_fija), si la tiene. */
export type ReglaAgenciaEmpresa = {
  agencia: string | null;
  formatoDoAgencia: string | null;
  mensajeAgencia: string | null;
  mensajeFormato: string | null;
};

export type TiposTramiteEmpresa = {
  tipos: TipoTramiteOption[];
  reglaAgencia: ReglaAgenciaEmpresa | null;
};

export type CreateTramiteInput = {
  ciudad: string;
  anio?: number;
  clienteId: string;
  /** Código de TipoTramite. Ausente = IMPORTACION. */
  tipoTramiteCodigo?: string;
  referenciaExterna?: string | null;
  proveedorCliente?: string | null;
  agenciaAduanas?: string;
  doAgencia?: string | null;
  doCliente?: string | null;
  eta?: string | null;
  comentarios?: string | null;
};

export class TramitesApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TramitesApiError";
    this.status = status;
  }
}

const textKeys = {
  doNumber: ["doNumber", "numeroDo", "numeroDO", "do", "consecutivo", "codigo"],
  cliente: ["cliente", "clienteNombre", "nombreCliente", "importador", "tercero"],
  estado: ["estado", "status", "etapa"],
  ciudad: ["ciudad", "ciudadOperacion", "puerto", "origen", "destino"],
  modalidad: ["modalidad", "tipoOperacion", "regimen", "operacion", "agenciaAduanas"],
  referencia: [
    "referencia",
    "referenciaCliente",
    "pedido",
    "bl",
    "documentoTransporte",
    "doAgencia",
    "doCliente",
    "proveedorCliente",
  ],
  fechaApertura: ["fechaApertura", "createdAt", "fechaCreacion", "apertura"],
  ultimoMovimiento: ["ultimoMovimiento", "updatedAt", "fechaActualizacion", "ultimaActividad"],
  responsable: ["responsable", "analista", "operativo", "usuarioAsignado", "creadoPor"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number") {
      return String(value);
    }

    if (isRecord(value)) {
      const nestedName = value.nombre ?? value.name ?? value.razonSocial;

      if (typeof nestedName === "string" && nestedName.trim()) {
        return nestedName.trim();
      }
    }
  }

  return "";
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }

  return null;
}

function countChecklistPendientes(record: Record<string, unknown>): number | null {
  const checklistItems = record.checklistItems;

  if (!Array.isArray(checklistItems)) {
    return null;
  }

  return checklistItems.filter((item) => {
    if (!isRecord(item)) {
      return false;
    }

    return item.requerido === true && item.recibido !== true;
  }).length;
}

function formatDate(value: string): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidates = [payload.tramites, payload.data, payload.items, payload.results];
  const rows = candidates.find(Array.isArray);

  return rows ?? [];
}

function normalizeRow(row: unknown, index: number): TramiteRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const id = readText(row, ["id", "uuid", "slug"]) || `tramite-${index}`;
  const doNumber = readText(row, textKeys.doNumber) || "Sin DO";

  return {
    id,
    doNumber,
    cliente: readText(row, textKeys.cliente) || "Sin cliente",
    estado: readText(row, textKeys.estado) || "Sin estado",
    ciudad: readText(row, textKeys.ciudad) || "Sin ciudad",
    modalidad: readText(row, textKeys.modalidad) || "Sin modalidad",
    referencia: readText(row, textKeys.referencia) || "-",
    fechaApertura: formatDate(readText(row, textKeys.fechaApertura)) || "-",
    ultimoMovimiento: formatDate(readText(row, textKeys.ultimoMovimiento)) || "-",
    responsable: readText(row, textKeys.responsable) || "Sin asignar",
    documentosPendientes:
      countChecklistPendientes(row) ??
      readNumber(row, [
        "documentosPendientes",
        "pendientes",
        "checklistPendiente",
        "documentosFaltantes",
      ]),
  };
}

/**
 * Página de trámites con `take`/`skip` y el `total` que devuelve el API
 * (`{ tramites, total }`). Sin `take` el servidor recorta a 50 en silencio.
 */
export async function fetchTramitesPage(
  signal?: AbortSignal,
  filters?: TramiteFilters,
  page: TramitesPageOptions = { take: TRAMITES_PAGE_SIZE, skip: 0 },
): Promise<TramitesPage> {
  let response: Response;

  try {
    response = await fetch(`/api/tramites${buildTramitesQuery(filters, page)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    throw new TramitesApiError("No fue posible conectar con /api/tramites.");
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new TramitesApiError("La API /api/tramites aún no está disponible.", 404);
    }

    throw new TramitesApiError("No fue posible cargar los trámites.", response.status);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new TramitesApiError("La respuesta de /api/tramites no es JSON válido.");
  }

  const rows = extractRows(payload)
    .map(normalizeRow)
    .filter((row): row is TramiteRow => row !== null);

  const total =
    isRecord(payload) && typeof payload.total === "number" && Number.isFinite(payload.total)
      ? payload.total
      : rows.length;

  return { rows, total };
}

export async function fetchTramites(
  signal?: AbortSignal,
  filters?: TramiteFilters,
  page?: TramitesPageOptions,
): Promise<TramiteRow[]> {
  const { rows } = await fetchTramitesPage(signal, filters, page);
  return rows;
}

export async function fetchClienteOptions(signal?: AbortSignal): Promise<ClienteOption[]> {
  const response = await fetch("/api/clientes", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new TramitesApiError("No fue posible cargar los clientes.", response.status);
  }

  const payload: unknown = await response.json();

  if (!isRecord(payload) || !Array.isArray(payload.clientes)) {
    return [];
  }

  return payload.clientes
    .filter(isRecord)
    .map((cliente) => ({
      id: readText(cliente, ["id"]),
      nombre: readText(cliente, ["nombre", "name"]),
      nit: readText(cliente, ["nit", "identificacion"]),
      tipo: readText(cliente, ["tipo"]),
    }))
    .filter((cliente) => cliente.id && cliente.nombre);
}

/**
 * Tipos de trámite que la empresa puede abrir (M4). Con `clienteId` el backend
 * ya filtra por capacidad, así que el formulario nunca ofrece algo que luego
 * vaya a rechazar.
 */
export async function fetchTiposTramite(
  clienteId: string,
  signal?: AbortSignal,
): Promise<TipoTramiteOption[]> {
  return (await fetchTiposTramiteEmpresa(clienteId, signal)).tipos;
}

function normalizarReglaAgencia(v: unknown): ReglaAgenciaEmpresa | null {
  if (!isRecord(v)) return null;
  const t = (x: unknown) => (typeof x === "string" && x ? x : null);
  const regla = {
    agencia: t(v.agencia),
    formatoDoAgencia: t(v.formatoDoAgencia),
    mensajeAgencia: t(v.mensajeAgencia),
    mensajeFormato: t(v.mensajeFormato),
  };
  return regla.agencia || regla.formatoDoAgencia ? regla : null;
}

/** Tipos que la empresa puede abrir y su agencia fija, en una sola llamada. */
export async function fetchTiposTramiteEmpresa(
  clienteId: string,
  signal?: AbortSignal,
): Promise<TiposTramiteEmpresa> {
  const response = await fetch(
    `/api/tipos-tramite?clienteId=${encodeURIComponent(clienteId)}`,
    { cache: "no-store", headers: { Accept: "application/json" }, signal },
  );

  if (!response.ok) {
    throw new TramitesApiError(
      "No fue posible cargar los tipos de trámite.",
      response.status,
    );
  }

  const payload: unknown = await response.json();

  if (!isRecord(payload) || !Array.isArray(payload.tipos)) {
    return { tipos: [], reglaAgencia: null };
  }

  const reglaAgencia = normalizarReglaAgencia(payload.reglaAgencia);

  const tipos = payload.tipos.filter(isRecord).map((tipo) => ({
    codigo: readText(tipo, ["codigo"]),
    nombre: readText(tipo, ["nombre"]),
    descripcion: typeof tipo.descripcion === "string" ? tipo.descripcion : null,
    prefijoConsecutivo: readText(tipo, ["prefijoConsecutivo"]),
    requiereAgenciaAduanas: tipo.requiereAgenciaAduanas !== false,
    requiereEta: tipo.requiereEta !== false,
    etiquetaReferenciaExterna:
      typeof tipo.etiquetaReferenciaExterna === "string"
        ? tipo.etiquetaReferenciaExterna
        : null,
  }));

  return { tipos, reglaAgencia };
}

export async function createTramite(input: CreateTramiteInput): Promise<TramiteRow> {
  const response = await fetch("/api/tramites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No fue posible crear el trámite.";

    throw new TramitesApiError(message, response.status);
  }

  if (!isRecord(payload)) {
    throw new TramitesApiError("La respuesta de creación no es válida.");
  }

  const row = normalizeRow(payload.tramite, 0);

  if (!row) {
    throw new TramitesApiError("No fue posible leer el trámite creado.");
  }

  return row;
}
