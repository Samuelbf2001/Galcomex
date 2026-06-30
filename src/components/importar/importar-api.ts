/**
 * Helpers de API para el módulo de Importación del workbook "GRUPO E PAPIS 2026".
 *   POST /api/importar/grupo-e-papis  (multipart/form-data)
 *     - file: .xlsm/.xls (≤ 25 MB)
 *     - clienteId: id del cliente existente
 *     - dryRun: "true" (previsualizar) | "false" (importar de verdad)
 * Todo el dinero llega como string desde el servidor.
 */

export type EstadoHoja = "IMPORTADO" | "OMITIDO" | "YA_EXISTIA" | "ERROR";

export interface FilaReconciliacion {
  concepto: string;
  sistema: string;
  excel: string;
  ok: boolean;
}

export interface ResultadoHoja {
  sheetName: string;
  consecutivo: string;
  numFacturaSiigo: string | null;
  estado: EstadoHoja;
  motivo?: string;
  cuadra: boolean;
  requirioOverride: boolean;
  reconciliacion: FilaReconciliacion[];
}

export interface ResultadoImport {
  clienteId: string;
  totalHojas: number;
  importadas: number;
  omitidas: number;
  errores: number;
  hojas: ResultadoHoja[];
}

export const MAX_SIZE_BYTES_IMPORT = 25 * 1024 * 1024; // 25 MB
export const EXTENSIONES_PERMITIDAS = [".xlsm", ".xls"] as const;

export class ImportarApiError extends Error {
  status?: number;
  details?: unknown;

  constructor(message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "ImportarApiError";
    this.status = status;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tieneExtensionValida(nombre: string): boolean {
  const lower = nombre.toLowerCase();
  return EXTENSIONES_PERMITIDAS.some((ext) => lower.endsWith(ext));
}

/** Validación de archivo en cliente (la API revalida en el server). */
export function validarArchivoImport(file: File): string | null {
  if (!tieneExtensionValida(file.name)) {
    return "Formato no permitido. Use un archivo .xlsm o .xls.";
  }
  if (file.size > MAX_SIZE_BYTES_IMPORT) {
    return "El archivo supera el máximo de 25 MB.";
  }
  if (file.size === 0) {
    return "El archivo está vacío.";
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeReconciliacion(raw: unknown): FilaReconciliacion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((fila) => ({
    concepto: asString(fila.concepto),
    sistema: asString(fila.sistema),
    excel: asString(fila.excel),
    ok: fila.ok === true,
  }));
}

const ESTADOS_VALIDOS: EstadoHoja[] = ["IMPORTADO", "OMITIDO", "YA_EXISTIA", "ERROR"];

function normalizeEstado(raw: unknown): EstadoHoja {
  return typeof raw === "string" && ESTADOS_VALIDOS.includes(raw as EstadoHoja)
    ? (raw as EstadoHoja)
    : "ERROR";
}

function normalizeHoja(raw: unknown): ResultadoHoja {
  if (!isRecord(raw)) {
    return {
      sheetName: "",
      consecutivo: "",
      numFacturaSiigo: null,
      estado: "ERROR",
      cuadra: false,
      requirioOverride: false,
      reconciliacion: [],
    };
  }

  return {
    sheetName: asString(raw.sheetName),
    consecutivo: asString(raw.consecutivo),
    numFacturaSiigo:
      typeof raw.numFacturaSiigo === "string" ? raw.numFacturaSiigo : null,
    estado: normalizeEstado(raw.estado),
    motivo: typeof raw.motivo === "string" ? raw.motivo : undefined,
    cuadra: raw.cuadra === true,
    requirioOverride: raw.requirioOverride === true,
    reconciliacion: normalizeReconciliacion(raw.reconciliacion),
  };
}

function normalizeResultado(raw: unknown): ResultadoImport {
  if (!isRecord(raw)) {
    throw new ImportarApiError("La respuesta del servidor no es válida.");
  }

  const hojas = Array.isArray(raw.hojas) ? raw.hojas.map(normalizeHoja) : [];

  return {
    clienteId: asString(raw.clienteId),
    totalHojas: typeof raw.totalHojas === "number" ? raw.totalHojas : hojas.length,
    importadas: typeof raw.importadas === "number" ? raw.importadas : 0,
    omitidas: typeof raw.omitidas === "number" ? raw.omitidas : 0,
    errores: typeof raw.errores === "number" ? raw.errores : 0,
    hojas,
  };
}

/**
 * Ejecuta la importación (o su previsualización con dryRun).
 */
export async function importarGrupoEPapis(input: {
  file: File;
  clienteId: string;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<ResultadoImport> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("clienteId", input.clienteId);
  form.append("dryRun", input.dryRun ? "true" : "false");

  let response: Response;
  try {
    response = await fetch("/api/importar/grupo-e-papis", {
      method: "POST",
      body: form,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ImportarApiError("No fue posible conectar con la API de importación.");
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error en la importación (${response.status}).`;
    const details = isRecord(payload) ? payload.details : undefined;
    throw new ImportarApiError(message, response.status, details);
  }

  if (!isRecord(payload)) {
    throw new ImportarApiError("La respuesta del servidor no es válida.");
  }

  return normalizeResultado(payload.reporte);
}
