const DEFAULT_MINIO_PORT = 9000;

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60;
export const DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS = 10 * 60;

export const ALLOWED_STORAGE_FILE_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
} as const;

export type AllowedStorageContentType = keyof typeof ALLOWED_STORAGE_FILE_TYPES;

export type StorageConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
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

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_MINIO_PORT;
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

export function getStorageConfig(): StorageConfig {
  const endPoint = getRequiredEnv("MINIO_ENDPOINT");
  const port = parsePort(process.env.MINIO_PORT);
  const useSSL = parseBoolean(process.env.MINIO_USE_SSL);

  return {
    endPoint,
    port,
    useSSL,
    accessKey: getRequiredEnv("MINIO_ACCESS_KEY"),
    secretKey: getRequiredEnv("MINIO_SECRET_KEY"),
    bucket: getRequiredEnv("MINIO_BUCKET"),
    region: process.env.MINIO_REGION || DEFAULT_REGION,
    // El endpoint público cae con gracia al interno cuando no se configura
    // (válido en dev local, donde MINIO_ENDPOINT ya es "localhost").
    publicEndPoint: process.env.MINIO_PUBLIC_ENDPOINT || endPoint,
    publicPort: process.env.MINIO_PUBLIC_PORT
      ? parsePort(process.env.MINIO_PUBLIC_PORT)
      : port,
    publicUseSSL: process.env.MINIO_PUBLIC_USE_SSL
      ? parseBoolean(process.env.MINIO_PUBLIC_USE_SSL)
      : useSSL,
  };
}
