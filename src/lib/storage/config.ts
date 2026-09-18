const DEFAULT_MINIO_PORT = 9000;
const DEFAULT_HTTPS_PORT = 443;

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60;
export const DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS = 10 * 60;

/**
 * Tipos aceptados en la bodega. La lista sale de lo que de verdad manda
 * Litoplas (histórico 2026, 11.500 archivos): además de PDF/imágenes/XLSX
 * llegan Excel viejos (.xls, 397), Word (.docx 129 / .doc 9), fotos
 * comprimidas (.zip 59 / .rar 16), correos (.eml 13) y videos (.mp4 5).
 * Windows reporta .zip como `application/x-zip-compressed` y .rar como
 * `application/x-rar-compressed`, por eso van las dos variantes.
 */
export const ALLOWED_STORAGE_FILE_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.rar": "rar",
  "application/x-rar-compressed": "rar",
  "message/rfc822": "eml",
  "video/mp4": "mp4",
} as const;

/** Extensiones para el `accept` de los inputs de archivo (misma lista de arriba). */
export const ACCEPTED_FILE_EXTENSIONS_ATTR =
  ".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.doc,.zip,.rar,.eml,.mp4";

export const ALLOWED_FILE_TYPES_LABEL = "PDF, JPG, PNG, XLSX/XLS, DOCX/DOC, ZIP, RAR, EML o MP4";

export type AllowedStorageContentType = keyof typeof ALLOWED_STORAGE_FILE_TYPES;

/**
 * Proveedor de almacenamiento. Todos hablan el mismo protocolo (S3), así que
 * la app no cambia de código: solo cambian endpoint, puerto, SSL, región y
 * llaves. El proveedor se usa para elegir valores por defecto sensatos y para
 * mostrar en la UI "dónde están los archivos".
 *
 *   minio — MinIO propio (Docker local o servicio en EasyPanel).
 *   r2    — Cloudflare R2 (`<cuenta>.r2.cloudflarestorage.com`, región `auto`).
 *   b2    — Backblaze B2 (`s3.<region>.backblazeb2.com`).
 *   s3    — Amazon S3.
 *   otro  — cualquier otro compatible (Wasabi, Hetzner, DigitalOcean Spaces…).
 */
export type ProveedorStorage = "minio" | "r2" | "b2" | "s3" | "otro";

export type StorageConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
  /** `true` = `https://host/bucket/clave` (MinIO, R2, B2); `false` = `https://bucket.host/clave`. */
  pathStyle: boolean;
  proveedor: ProveedorStorage;
  /**
   * Endpoint PÚBLICO usado solo para firmar URLs prefirmadas (upload/download).
   * El navegador del usuario hace el PUT/GET directo contra este host, por lo que
   * debe ser alcanzable desde fuera de la red interna de Docker. Cuando la app
   * corre en Docker, `endPoint` es el hostname interno (ej. "minio") que el
   * navegador NO puede resolver — de ahí el "Error de red al subir el archivo".
   */
  publicEndPoint: string;
  publicPort: number;
  publicUseSSL: boolean;
};

/** Región por defecto de MinIO; fijarla evita un GetBucketLocation en cada presign. */
const DEFAULT_REGION = "us-east-1";
/** Cloudflare R2 exige `auto` como región en la firma. */
const R2_REGION = "auto";

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new StorageConfigError(`Falta configurar ${name}`);
  }

  return value;
}

function parsePort(value: string | undefined, porDefecto: number): number {
  if (!value) {
    return porDefecto;
  }

  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new StorageConfigError("MINIO_PORT debe ser un puerto valido");
  }

  return port;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

/** Adivina el proveedor por el host cuando `STORAGE_PROVIDER` no viene. */
export function detectarProveedor(endPoint: string, declarado?: string): ProveedorStorage {
  const valor = declarado?.trim().toLowerCase();
  if (valor === "minio" || valor === "r2" || valor === "b2" || valor === "s3" || valor === "otro") {
    return valor;
  }
  if (valor) {
    throw new StorageConfigError(
      `STORAGE_PROVIDER "${declarado}" no es válido (minio | r2 | b2 | s3 | otro)`,
    );
  }

  const host = endPoint.toLowerCase();
  if (host.endsWith(".r2.cloudflarestorage.com")) return "r2";
  if (host.endsWith(".backblazeb2.com")) return "b2";
  if (host.endsWith(".amazonaws.com")) return "s3";
  if (host === "minio" || host === "localhost" || host === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return "minio";
  }
  return "otro";
}

export const NOMBRE_PROVEEDOR: Record<ProveedorStorage, string> = {
  minio: "MinIO",
  r2: "Cloudflare R2",
  b2: "Backblaze B2",
  s3: "Amazon S3",
  otro: "Almacenamiento S3",
};

export function getStorageConfig(): StorageConfig {
  const endPoint = getRequiredEnv("MINIO_ENDPOINT");
  const useSSL = parseBoolean(process.env.MINIO_USE_SSL);
  // Sin puerto explícito: 443 si va por HTTPS (R2, B2, S3), 9000 si es MinIO plano.
  const port = parsePort(process.env.MINIO_PORT, useSSL ? DEFAULT_HTTPS_PORT : DEFAULT_MINIO_PORT);
  const proveedor = detectarProveedor(endPoint, process.env.STORAGE_PROVIDER);
  const region = process.env.MINIO_REGION || (proveedor === "r2" ? R2_REGION : DEFAULT_REGION);
  const pathStyle = process.env.MINIO_PATH_STYLE ? parseBoolean(process.env.MINIO_PATH_STYLE) : true;

  return {
    endPoint,
    port,
    useSSL,
    accessKey: getRequiredEnv("MINIO_ACCESS_KEY"),
    secretKey: getRequiredEnv("MINIO_SECRET_KEY"),
    bucket: getRequiredEnv("MINIO_BUCKET"),
    region,
    pathStyle,
    proveedor,
    // El endpoint público cae con gracia al interno cuando no se configura
    // (válido en dev local, donde MINIO_ENDPOINT ya es "localhost").
    publicEndPoint: process.env.MINIO_PUBLIC_ENDPOINT || endPoint,
    publicPort: process.env.MINIO_PUBLIC_PORT
      ? parsePort(process.env.MINIO_PUBLIC_PORT, port)
      : port,
    publicUseSSL: process.env.MINIO_PUBLIC_USE_SSL
      ? parseBoolean(process.env.MINIO_PUBLIC_USE_SSL)
      : useSSL,
  };
}

export type ResumenStorage = {
  proveedor: ProveedorStorage;
  nombreProveedor: string;
  bucket: string;
  /** `https://host:puerto` sin credenciales, apto para mostrar en pantalla. */
  endpoint: string;
  region?: string;
};

/** Descripción del almacenamiento SIN secretos, para la UI y el script de verificación. */
export function resumenStorage(config: StorageConfig = getStorageConfig()): ResumenStorage {
  const esquema = config.useSSL ? "https" : "http";
  const puertoImplicito = (config.useSSL && config.port === 443) || (!config.useSSL && config.port === 80);
  return {
    proveedor: config.proveedor,
    nombreProveedor: NOMBRE_PROVEEDOR[config.proveedor],
    bucket: config.bucket,
    endpoint: `${esquema}://${config.endPoint}${puertoImplicito ? "" : `:${config.port}`}`,
    region: config.region,
  };
}
