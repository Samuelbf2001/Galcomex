/**
 * Helpers de API para el módulo de Documentos (repositorio documental del DO).
 * El cliente sube DIRECTAMENTE a MinIO usando la URL prefirmada:
 *   1. POST /api/tramites/[id]/documentos { action: "uploadUrl", ... } → presigned PUT URL
 *   2. fetch(presignedUrl, { method: "PUT", body: file })
 *   3. POST /api/tramites/[id]/documentos { action: "register", ... } → crea Documento en BD
 */

export type CategoriaDocumento =
  | "FACTURA_COMERCIAL"
  | "BL"
  | "PACKING_LIST"
  | "DECLARACION_DIAN"
  | "SOPORTE_FACTURACION"
  | "FOTO_RECONOCIMIENTO"
  | "COMPROBANTE_BANCARIO"
  | "FACTURA_PROVEEDOR"
  | "OTRO";

export const CATEGORIAS_DOCUMENTO: { value: CategoriaDocumento; label: string }[] = [
  { value: "FACTURA_COMERCIAL", label: "Factura Comercial" },
  { value: "BL", label: "Bill of Lading (BL)" },
  { value: "PACKING_LIST", label: "Packing List" },
  { value: "DECLARACION_DIAN", label: "Declaración DIAN" },
  { value: "SOPORTE_FACTURACION", label: "Soporte de Facturación" },
  { value: "FOTO_RECONOCIMIENTO", label: "Foto de Reconocimiento" },
  { value: "COMPROBANTE_BANCARIO", label: "Comprobante Bancario" },
  { value: "FACTURA_PROVEEDOR", label: "Factura Proveedor" },
  { value: "OTRO", label: "Otro" },
];

export type DocumentoRow = {
  id: string;
  tramiteId: string;
  categoria: CategoriaDocumento;
  nombreArchivo: string;
  storageKey: string;
  mimeType: string;
  tamanoBytes: number;
  eliminado: boolean;
  subidoPorId: string;
  subidoPor: { id: string; name: string };
  createdAt: string;
  downloadUrl: string;
};

export type DocumentosPorCategoria = Record<string, DocumentoRow[]>;

export type UploadUrlResult = {
  storageKey: string;
  uploadUrl: string;
  method: "PUT";
  contentType: string;
  maxSizeBytes: number;
  expiresInSeconds: number;
};

export class DocumentosApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DocumentosApiError";
    this.status = status;
  }
}

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

/**
 * Paso 1: solicitar URL prefirmada de subida al backend.
 */
export async function solicitarUploadUrl(
  tramiteId: string,
  input: {
    categoria: CategoriaDocumento;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  },
): Promise<UploadUrlResult> {
  const response = await fetch(`/api/tramites/${tramiteId}/documentos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action: "uploadUrl", ...input }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al solicitar URL de subida (${response.status}).`;
    throw new DocumentosApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.uploadUrl)) {
    throw new DocumentosApiError("Respuesta de URL de subida no válida.");
  }

  const u = payload.uploadUrl;
  return {
    storageKey: String(u.storageKey ?? ""),
    uploadUrl: String(u.uploadUrl ?? ""),
    method: "PUT",
    contentType: String(u.contentType ?? ""),
    maxSizeBytes: typeof u.maxSizeBytes === "number" ? u.maxSizeBytes : 25 * 1024 * 1024,
    expiresInSeconds: typeof u.expiresInSeconds === "number" ? u.expiresInSeconds : 600,
  };
}

/**
 * Paso 2: subir el archivo DIRECTO a MinIO con la URL prefirmada.
 * Retorna true si el PUT fue exitoso.
 */
export async function subirArchivoDirecto(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    if (onProgress) {
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) {
          onProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new DocumentosApiError(`Fallo al subir el archivo (${xhr.status}).`));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new DocumentosApiError("Error de red al subir el archivo."));
    });

    xhr.send(file);
  });
}

/**
 * Paso 3: registrar el documento en BD después de la subida.
 */
export async function registrarDocumento(
  tramiteId: string,
  input: {
    categoria: CategoriaDocumento;
    nombreArchivo: string;
    storageKey: string;
    mimeType: string;
    tamanoBytes: number;
  },
): Promise<DocumentoRow> {
  const response = await fetch(`/api/tramites/${tramiteId}/documentos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action: "register", ...input }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al registrar el documento (${response.status}).`;
    throw new DocumentosApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.documento)) {
    throw new DocumentosApiError("Respuesta de registro no válida.");
  }

  return parseDocumentoRow(payload.documento);
}

/**
 * Listar documentos de un trámite, agrupados por categoría.
 */
export async function fetchDocumentos(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<DocumentosPorCategoria> {
  let response: Response;

  try {
    response = await fetch(`/api/tramites/${tramiteId}/documentos`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DocumentosApiError("No fue posible conectar con la API de documentos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new DocumentosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.documentos)) {
    throw new DocumentosApiError("Respuesta de documentos no válida.");
  }

  const result: DocumentosPorCategoria = {};
  for (const [categoria, docs] of Object.entries(payload.documentos)) {
    if (Array.isArray(docs)) {
      result[categoria] = docs.filter(isRecord).map(parseDocumentoRow);
    }
  }
  return result;
}

/**
 * Eliminar (soft-delete) un documento.
 */
export async function eliminarDocumento(
  tramiteId: string,
  documentoId: string,
): Promise<void> {
  const response = await fetch(`/api/tramites/${tramiteId}/documentos/${documentoId}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });

  if (!response.ok && response.status !== 204) {
    const msg = await parseErrorMessage(response);
    throw new DocumentosApiError(msg, response.status);
  }
}

/**
 * Refrescar la URL de descarga de un documento específico.
 */
export async function refrescarUrl(
  tramiteId: string,
  documentoId: string,
): Promise<string> {
  const response = await fetch(`/api/tramites/${tramiteId}/documentos/${documentoId}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new DocumentosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.url !== "string") {
    throw new DocumentosApiError("Respuesta de URL inválida.");
  }
  return payload.url;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function parseDocumentoRow(raw: Record<string, unknown>): DocumentoRow {
  const subidoPor = isRecord(raw.subidoPor) ? raw.subidoPor : {};
  return {
    id: String(raw.id ?? ""),
    tramiteId: String(raw.tramiteId ?? ""),
    categoria: (raw.categoria as CategoriaDocumento) ?? "OTRO",
    nombreArchivo: String(raw.nombreArchivo ?? ""),
    storageKey: String(raw.storageKey ?? ""),
    mimeType: String(raw.mimeType ?? ""),
    tamanoBytes: typeof raw.tamanoBytes === "number" ? raw.tamanoBytes : 0,
    eliminado: raw.eliminado === true,
    subidoPorId: String(raw.subidoPorId ?? ""),
    subidoPor: {
      id: String(subidoPor.id ?? ""),
      name: String(subidoPor.name ?? ""),
    },
    createdAt: String(raw.createdAt ?? ""),
    downloadUrl: String(raw.downloadUrl ?? ""),
  };
}

/** Formatea bytes a cadena legible: 1.2 MB, 340 KB, etc. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tipos MIME permitidos por la config de storage */
export const MIME_TIPOS_PERMITIDOS = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export function validarArchivo(file: File): string | null {
  if (!MIME_TIPOS_PERMITIDOS.includes(file.type)) {
    return `Tipo no permitido (${file.type}). Use PDF, JPG, PNG o XLSX.`;
  }
  if (file.size > MAX_SIZE_BYTES) {
    return `El archivo supera el máximo de 25 MB (${formatBytes(file.size)}).`;
  }
  if (file.size === 0) {
    return "El archivo está vacío.";
  }
  return null;
}
