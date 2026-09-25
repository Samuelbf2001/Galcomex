export type TramiteRow = {
  id: string;
  doNumber: string;
  cliente: string;
  /** Id de la empresa (Cliente) — enlace a /clientes/[id] (ver enlace-entidad.tsx). */
  clienteId: string | null;
  estado: string;
  ciudad: string;
  modalidad: string;
  referencia: string;
  fechaApertura: string;
  ultimoMovimiento: string;
  responsable: string;
  documentosPendientes: number | null;
  /** Cargado desde el archivo histórico (Drive): existe por sus documentos, sin detalle financiero. */
  esHistorico: boolean;
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

/**
 * Columnas ordenables de la tabla de trámites (A8). Referencia (coalesce de
 * doAgencia/doCliente/proveedorCliente) y Docs (conteo calculado en el
 * cliente) no están: no son ordenables.
 */
export type CampoOrdenTramite =
  | "consecutivo"
  | "cliente"
  | "estado"
  | "ciudad"
  | "modalidad"
  | "apertura"
  | "movimiento"
  | "responsable";

export type OrdenTramites = { campo: CampoOrdenTramite; direccion: "asc" | "desc" };

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

function buildTramitesQuery(
  filters?: TramiteFilters,
  page?: TramitesPageOptions,
  orden?: OrdenTramites | null,
): string {
  const params = new URLSearchParams();
  const q = filters?.q?.trim();

  if (page?.take !== undefined) {
    params.set("take", String(page.take));
  }

  if (page?.skip !== undefined && page.skip > 0) {
    params.set("skip", String(page.skip));
  }

  if (orden) {
    params.set("ordenarPor", orden.campo);
    params.set("direccion", orden.direccion);
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
  /** Muestra "DO agencia"/"DO cliente" en el formulario. false en CLASIFICACION. */
  usaCamposDo: boolean;
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
  /**
   * Código estable del bloqueo cuando el servidor lo manda (p. ej.
   * `TARIFA_VIGENTE_REQUERIDA` al crear un DO sin tarifa vigente).
   */
  codigo?: string;
  /** Datos del bloqueo (p. ej. `{ clienteId, lineaServicio, tipoTramiteCodigo }`). */
  detalles?: Record<string, unknown>;
  /** Checklist pendiente cuando el bloqueo es "Checklist requerido incompleto". */
  faltantes?: string[];

  constructor(
    message: string,
    status?: number,
    extra?: { codigo?: string; detalles?: Record<string, unknown>; faltantes?: string[] },
  ) {
    super(message);
    this.name = "TramitesApiError";
    this.status = status;
    this.codigo = extra?.codigo;
    this.detalles = extra?.detalles;
    this.faltantes = extra?.faltantes;
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

/** Id del cliente anidado (p.ej. `row.cliente.id`), si el backend lo incluyó. */
function readNestedClienteId(record: Record<string, unknown>): string | null {
  const cliente = record.cliente;
  if (isRecord(cliente) && typeof cliente.id === "string" && cliente.id) {
    return cliente.id;
  }
  return null;
}

/**
 * Tipos con `usaCamposDo=false` (CLASIFICACION) no tienen DO agencia/cliente:
 * la columna "Referencia" de la lista debe mostrar `referenciaExterna` (el
 * número de la clasificadora) en vez del coalesce de siempre.
 */
function referenciaExternaSiAplica(record: Record<string, unknown>): string | null {
  const tipoTramite = record.tipoTramite;
  const usaCamposDo = isRecord(tipoTramite) ? tipoTramite.usaCamposDo !== false : true;

  if (usaCamposDo) {
    return null;
  }

  const valor = record.referenciaExterna;
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
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
    clienteId: readNestedClienteId(row),
    estado: readText(row, textKeys.estado) || "Sin estado",
    ciudad: readText(row, textKeys.ciudad) || "Sin ciudad",
    modalidad: readText(row, textKeys.modalidad) || "Sin modalidad",
    referencia: referenciaExternaSiAplica(row) ?? (readText(row, textKeys.referencia) || "-"),
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
    esHistorico: row.esHistorico === true,
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
  orden?: OrdenTramites | null,
): Promise<TramitesPage> {
  let response: Response;

  try {
    response = await fetch(`/api/tramites${buildTramitesQuery(filters, page, orden)}`, {
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
  // F1: el DO siempre se abre a nombre de una empresa CLIENTE — una
  // solo-proveedor (ALMACARGA, EXPRESS LOGISTICA) no debe salir aquí.
  const response = await fetch("/api/clientes?rol=cliente", {
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
    usaCamposDo: tipo.usaCamposDo !== false,
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

    throw new TramitesApiError(message, response.status, extraDeError(payload));
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

/** Resultado de `cambiarEstadoTramite` (F6): el trámite actualizado + lo que el ADMIN se saltó. */
export type CambioEstadoResultado<T = Record<string, unknown>> = {
  tramite: T;
  /**
   * Requisitos que el ADMIN se saltó con su excepción (checklist, BL y
   * factura comercial) — vacío en una transición normal. El llamador decide
   * cómo mostrarlas (toast de advertencia tras el de éxito).
   */
  advertencias: string[];
};

/**
 * POST /api/tramites/[id]/estado — mueve el trámite a otro estado del
 * pipeline. Único punto de llamada al endpoint (F6): antes cada pantalla
 * (ficha del DO, kanban) hacía su propio `fetch` y descartaba `advertencias`
 * en silencio; ahora todas pasan por acá y el llamador puede avisarle al
 * usuario que se saltó un requisito.
 */
export async function cambiarEstadoTramite<T = Record<string, unknown>>(
  tramiteId: string,
  estado: string,
): Promise<CambioEstadoResultado<T>> {
  const response = await fetch(`/api/tramites/${tramiteId}/estado`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ estado }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible cambiar el estado (${response.status}).`;
    const faltantes =
      isRecord(payload) && Array.isArray(payload.faltantes)
        ? (payload.faltantes as string[])
        : undefined;

    throw new TramitesApiError(message, response.status, { ...extraDeError(payload), faltantes });
  }

  if (!isRecord(payload) || !isRecord(payload.tramite)) {
    throw new TramitesApiError("Respuesta inesperada al cambiar estado.");
  }

  return {
    tramite: payload.tramite as T,
    advertencias: Array.isArray(payload.advertencias)
      ? payload.advertencias.filter((a): a is string => typeof a === "string")
      : [],
  };
}

/**
 * Título + descripción para el toast de advertencia tras un cambio de estado
 * con `advertencias` (F6) — p. ej. "Se avanzó saltando requisitos: falta el
 * BL y la factura comercial…". `null` si no hubo ninguna (transición normal).
 */
export function mensajeAdvertenciasEstado(
  advertencias: string[],
): { title: string; description: string } | null {
  if (advertencias.length === 0) return null;
  return { title: "Se avanzó saltando requisitos", description: advertencias.join(" ") };
}

// ─── Requisitos del DO (tarifa vigente, BL + factura comercial) ──────────────

/** `codigo`/`detalles` de un error del API, si vienen (ver `TramitesApiError`). */
function extraDeError(payload: unknown): { codigo?: string; detalles?: Record<string, unknown> } {
  if (!isRecord(payload)) return {};
  return {
    codigo: typeof payload.codigo === "string" ? payload.codigo : undefined,
    detalles: isRecord(payload.detalles) ? payload.detalles : undefined,
  };
}

/** Códigos de bloqueo que manda el servidor al crear o mover un DO. */
export const CODIGO_TARIFA_VIGENTE_REQUERIDA = "TARIFA_VIGENTE_REQUERIDA";
export const CODIGO_DOCUMENTOS_OBLIGATORIOS_FALTANTES = "DOCUMENTOS_OBLIGATORIOS_FALTANTES";

/** Categorías de documento que exige la función "BL y factura comercial obligatorios". */
export type DocumentoObligatorioCodigo = "BL" | "FACTURA_COMERCIAL";

export const ETIQUETA_DOCUMENTO_OBLIGATORIO: Record<DocumentoObligatorioCodigo, string> = {
  BL: "BL o guía",
  FACTURA_COMERCIAL: "Factura comercial",
};

/** Respuesta de `GET /api/tramites/requisitos`. */
export type RequisitosDo = {
  tarifaVigente: {
    /** La empresa tiene encendida "DO solo con tarifa vigente" para este tipo. */
    requerida: boolean;
    /** `true` si no se exige o si hay tarifa vigente hoy: se puede crear el DO. */
    cumple: boolean;
    /** Línea de servicio del tipo (TRAMITE, CLASIFICACION, OTROS…). */
    lineaServicio: string;
    /** Tarifa vigente hoy para esa línea (se exija o no). */
    tarifario: { id: string; nombre: string; version: number; vigenteHasta: string } | null;
    /** Sin "Tarifario propio versionado" la empresa no puede cargar tarifas: hay que activarlo primero. */
    tarifarioPropioHabilitado: boolean;
    /** El mismo texto que devolvería el servidor al crear; `null` si cumple. */
    mensaje: string | null;
  };
  documentosObligatorios: {
    /** Documentos que el DO debe tener (vacío = ninguno). Se suben justo después de crearlo. */
    requeridos: DocumentoObligatorioCodigo[];
  };
};

function esDocumentoObligatorio(valor: unknown): valor is DocumentoObligatorioCodigo {
  return valor === "BL" || valor === "FACTURA_COMERCIAL";
}

function normalizarRequisitos(payload: unknown): RequisitosDo {
  const tarifa = isRecord(payload) && isRecord(payload.tarifaVigente) ? payload.tarifaVigente : {};
  const documentos =
    isRecord(payload) && isRecord(payload.documentosObligatorios)
      ? payload.documentosObligatorios
      : {};
  const tarifario = isRecord(tarifa.tarifario) ? tarifa.tarifario : null;

  return {
    tarifaVigente: {
      requerida: tarifa.requerida === true,
      // Ante una respuesta rara no se bloquea en el navegador: el servidor manda.
      cumple: tarifa.cumple !== false,
      lineaServicio: typeof tarifa.lineaServicio === "string" ? tarifa.lineaServicio : "",
      tarifario:
        tarifario && typeof tarifario.id === "string"
          ? {
              id: tarifario.id,
              nombre: typeof tarifario.nombre === "string" ? tarifario.nombre : "",
              version: typeof tarifario.version === "number" ? tarifario.version : 0,
              vigenteHasta: typeof tarifario.vigenteHasta === "string" ? tarifario.vigenteHasta : "",
            }
          : null,
      tarifarioPropioHabilitado: tarifa.tarifarioPropioHabilitado === true,
      mensaje: typeof tarifa.mensaje === "string" ? tarifa.mensaje : null,
    },
    documentosObligatorios: {
      requeridos: Array.isArray(documentos.requeridos)
        ? documentos.requeridos.filter(esDocumentoObligatorio)
        : [],
    },
  };
}

/**
 * Qué le exige el sistema a un DO de esta empresa y tipo ANTES de crearlo:
 * tarifa vigente (si no cumple, llevar a `/clientes/{clienteId}?abrir=tarifas`)
 * y documentos obligatorios (pedirlos en el formulario).
 */
export async function fetchRequisitosDo(
  clienteId: string,
  tipoTramiteCodigo?: string,
  signal?: AbortSignal,
): Promise<RequisitosDo> {
  const params = new URLSearchParams({ clienteId });
  if (tipoTramiteCodigo) params.set("tipoTramiteCodigo", tipoTramiteCodigo);

  const response = await fetch(`/api/tramites/requisitos?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new TramitesApiError(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No fue posible consultar los requisitos del DO.",
      response.status,
      extraDeError(payload),
    );
  }

  return normalizarRequisitos(payload);
}
