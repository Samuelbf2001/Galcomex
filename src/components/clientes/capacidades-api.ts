/**
 * Cliente HTTP de los interruptores de función por empresa (M1).
 * Mismo estilo defensivo que `clientes-api.ts`: la UI nunca confía en la forma
 * del JSON y degrada a valores seguros.
 */

export type ConfigCapacidad = Record<string, unknown> | null;

export type CapacidadRow = {
  codigo: string;
  nombre: string;
  descripcion: string;
  grupo: string;
  habilitado: boolean;
  config: ConfigCapacidad;
  porDefecto: boolean;
  origenHabilitado: string;
  origenConfig: string;
  tieneOverride: boolean;
};

export type CambioCapacidad = {
  codigo: string;
  heredar?: boolean;
  habilitado?: boolean;
  config?: ConfigCapacidad;
};

export class CapacidadesApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CapacidadesApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCapacidad(row: unknown): CapacidadRow | null {
  if (!isRecord(row) || typeof row.codigo !== "string") {
    return null;
  }

  return {
    codigo: row.codigo,
    nombre: typeof row.nombre === "string" ? row.nombre : row.codigo,
    descripcion: typeof row.descripcion === "string" ? row.descripcion : "",
    grupo: typeof row.grupo === "string" ? row.grupo : "General",
    habilitado: row.habilitado === true,
    config: isRecord(row.config) ? row.config : null,
    porDefecto: row.porDefecto === true,
    origenHabilitado:
      typeof row.origenHabilitado === "string" ? row.origenHabilitado : "DEFECTO",
    origenConfig: typeof row.origenConfig === "string" ? row.origenConfig : "DEFECTO",
    tieneOverride: row.tieneOverride === true,
  };
}

function parseLista(payload: unknown): CapacidadRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.capacidades)) {
    return [];
  }

  return payload.capacidades
    .map(normalizeCapacidad)
    .filter((capacidad): capacidad is CapacidadRow => capacidad !== null);
}

async function mensajeDeError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    /* respuesta sin cuerpo JSON */
  }

  return fallback;
}

export async function fetchCapacidades(
  clienteId: string,
  signal?: AbortSignal,
): Promise<CapacidadRow[]> {
  const response = await fetch(`/api/clientes/${clienteId}/capacidades`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new CapacidadesApiError(
      await mensajeDeError(response, "No fue posible cargar las funciones."),
      response.status,
    );
  }

  return parseLista(await response.json());
}

export async function guardarCapacidades(
  clienteId: string,
  cambios: CambioCapacidad[],
): Promise<CapacidadRow[]> {
  const response = await fetch(`/api/clientes/${clienteId}/capacidades`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ cambios }),
  });

  if (!response.ok) {
    throw new CapacidadesApiError(
      await mensajeDeError(response, "No fue posible guardar el cambio."),
      response.status,
    );
  }

  return parseLista(await response.json());
}
