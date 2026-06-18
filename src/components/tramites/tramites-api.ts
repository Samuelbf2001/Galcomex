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

export type CreateTramiteInput = {
  ciudad: string;
  anio?: number;
  clienteId: string;
  proveedorCliente?: string | null;
  agenciaAduanas: string;
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

export async function fetchTramites(signal?: AbortSignal): Promise<TramiteRow[]> {
  let response: Response;

  try {
    response = await fetch("/api/tramites", {
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
      throw new TramitesApiError("La API /api/tramites aun no esta disponible.", 404);
    }

    throw new TramitesApiError("No fue posible cargar los tramites.", response.status);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new TramitesApiError("La respuesta de /api/tramites no es JSON valido.");
  }

  return extractRows(payload)
    .map(normalizeRow)
    .filter((row): row is TramiteRow => row !== null);
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
        : "No fue posible crear el tramite.";

    throw new TramitesApiError(message, response.status);
  }

  if (!isRecord(payload)) {
    throw new TramitesApiError("La respuesta de creacion no es valida.");
  }

  const row = normalizeRow(payload.tramite, 0);

  if (!row) {
    throw new TramitesApiError("No fue posible leer el tramite creado.");
  }

  return row;
}
