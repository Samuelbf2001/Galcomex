import { randomUUID } from "node:crypto";

import { CopyDestinationOptions, CopySourceOptions, type BucketItem } from "minio";

import {
  ALLOWED_FILE_TYPES_LABEL,
  ALLOWED_STORAGE_FILE_TYPES,
  DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS,
  MAX_PRESIGNED_URL_EXPIRY_SECONDS,
  MAX_UPLOAD_SIZE_BYTES,
  getStorageConfig,
  type AllowedStorageContentType,
} from "@/lib/storage/config";
import { getStorageClient, getStoragePublicClient } from "@/lib/storage/client";
import { urlFirmada } from "@/lib/storage/proxy";

/**
 * Por defecto los enlaces de subida y descarga pasan por la app
 * (`/api/storage/objeto`, ver `proxy.ts`): funcionan aunque la bodega no sea
 * pública. `STORAGE_DIRECT_PRESIGN=true` vuelve a las URLs prefirmadas de S3
 * (navegador ↔ bodega directo): exige `MINIO_PUBLIC_ENDPOINT` por HTTPS y CORS en el bucket.
 */
function usarPresignDirecto(): boolean {
  return process.env.STORAGE_DIRECT_PRESIGN === "true";
}

function vencimientoEpoch(expiresInSeconds: number): number {
  return Math.floor(Date.now() / 1000) + expiresInSeconds;
}

const DELETED_PREFIX = "deleted/";

export type StorageFileInput = {
  fileName?: string;
  contentType: string;
  sizeBytes: number;
};

export type StorageKeyInput = {
  consecutivo: string;
  categoria: string;
  carpeta?: string;
  fileName?: string;
  contentType: string;
};

export type StorageObject = {
  storageKey: string;
  size: number;
  etag?: string;
  lastModified?: Date;
};

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

export function isAllowedStorageContentType(
  contentType: string,
): contentType is AllowedStorageContentType {
  return contentType in ALLOWED_STORAGE_FILE_TYPES;
}

export function validateStorageFile(input: StorageFileInput): AllowedStorageContentType {
  if (
    !Number.isInteger(input.sizeBytes) ||
    !Number.isFinite(input.sizeBytes) ||
    input.sizeBytes <= 0
  ) {
    throw new StorageValidationError("El tamano del archivo debe ser mayor a cero");
  }

  if (input.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new StorageValidationError("El archivo supera el maximo permitido de 25MB");
  }

  if (!isAllowedStorageContentType(input.contentType)) {
    throw new StorageValidationError(
      `Tipo de archivo no permitido. Use ${ALLOWED_FILE_TYPES_LABEL}`,
    );
  }

  const extension = getFileExtension(input.fileName);
  const expectedExtension = ALLOWED_STORAGE_FILE_TYPES[input.contentType];

  if (extension && normalizeExtension(extension) !== expectedExtension) {
    throw new StorageValidationError("La extension no coincide con el tipo de archivo");
  }

  return input.contentType;
}

export function generateStorageKey(input: StorageKeyInput): string {
  const contentType = validateStorageFile({
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: 1,
  });
  const consecutivo = sanitizePathSegment(input.consecutivo, "consecutivo");
  const carpeta = sanitizePathSegment(input.carpeta ?? input.categoria, "carpeta");
  const extension = ALLOWED_STORAGE_FILE_TYPES[contentType];

  return `tramites/${consecutivo}/${carpeta}/${randomUUID()}.${extension}`;
}

export async function createPresignedUploadUrl(input: {
  consecutivo: string;
  categoria: string;
  carpeta?: string;
  fileName?: string;
  contentType: string;
  sizeBytes: number;
  expiresInSeconds?: number;
}) {
  const contentType = validateStorageFile(input);
  const storageKey = generateStorageKey(input);
  const expiresInSeconds = normalizeExpiry(input.expiresInSeconds);
  const { bucket } = getStorageConfig();
  const url = usarPresignDirecto()
    ? await getStoragePublicClient().presignedPutObject(bucket, storageKey, expiresInSeconds)
    : urlFirmada({
        metodo: "PUT",
        storageKey,
        contentType,
        sizeBytes: input.sizeBytes,
        exp: vencimientoEpoch(expiresInSeconds),
      });

  return {
    storageKey,
    url,
    method: "PUT" as const,
    contentType,
    maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
    expiresInSeconds,
  };
}

export async function createPresignedDownloadUrl(input: {
  storageKey: string;
  expiresInSeconds?: number;
}) {
  const storageKey = validateStorageKey(input.storageKey);
  const expiresInSeconds = normalizeExpiry(input.expiresInSeconds);
  const { bucket } = getStorageConfig();
  const url = usarPresignDirecto()
    ? await getStoragePublicClient().presignedGetObject(bucket, storageKey, expiresInSeconds)
    : urlFirmada({ metodo: "GET", storageKey, exp: vencimientoEpoch(expiresInSeconds) });

  return {
    storageKey,
    url,
    method: "GET" as const,
    expiresInSeconds,
  };
}

export async function listStorageObjects(input: {
  prefix?: string;
  includeDeleted?: boolean;
} = {}): Promise<StorageObject[]> {
  const { bucket } = getStorageConfig();
  const prefix = input.prefix ? validateStoragePrefix(input.prefix) : "tramites/";
  const stream = getStorageClient().listObjectsV2(bucket, prefix, true);
  const objects: StorageObject[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (item: BucketItem) => {
      if (!item.name || (!input.includeDeleted && item.name.startsWith(DELETED_PREFIX))) {
        return;
      }

      objects.push({
        storageKey: item.name,
        size: item.size,
        etag: item.etag,
        lastModified: item.lastModified,
      });
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return objects;
}

export async function ensureStorageBucket(): Promise<void> {
  const { bucket } = getStorageConfig();
  const client = getStorageClient();
  const exists = await client.bucketExists(bucket);

  if (!exists) {
    await client.makeBucket(bucket);
  }
}

export async function softDeleteStorageObject(input: {
  storageKey: string;
  deletedBy?: string;
}) {
  const storageKey = validateStorageKey(input.storageKey);
  const deletedAt = new Date();
  const deletedStorageKey = `${DELETED_PREFIX}${toPathTimestamp(deletedAt)}/${storageKey}`;
  const { bucket } = getStorageConfig();
  const client = getStorageClient();

  await client.copyObject(
    new CopySourceOptions({ Bucket: bucket, Object: storageKey }),
    new CopyDestinationOptions({
      Bucket: bucket,
      Object: deletedStorageKey,
      MetadataDirective: "REPLACE",
      UserMetadata: {
        "deleted-at": deletedAt.toISOString(),
        "deleted-by": input.deletedBy ?? "system",
        "original-storage-key": storageKey,
      },
    }),
  );
  await client.removeObject(bucket, storageKey);

  return {
    storageKey,
    deletedStorageKey,
    deletedAt,
  };
}

/**
 * Mueve un objeto dentro del bucket (copiar + borrar el origen). S3 no tiene
 * "rename": es la única forma de cambiar de carpeta un archivo ya subido, p. ej.
 * al recategorizar un documento (`OTRO/` → `BL/`). Si el destino ya existe se
 * sobreescribe; si origen y destino son iguales no hace nada.
 */
export async function moveStorageObject(input: { from: string; to: string }): Promise<void> {
  const from = validateStorageKey(input.from);
  const to = validateStorageKey(input.to);
  if (from === to) return;

  const { bucket } = getStorageConfig();
  const client = getStorageClient();

  await client.copyObject(
    new CopySourceOptions({ Bucket: bucket, Object: from }),
    new CopyDestinationOptions({ Bucket: bucket, Object: to }),
  );
  await client.removeObject(bucket, from);
}

export async function hardDeleteStorageObject(storageKey: string): Promise<void> {
  const { bucket } = getStorageConfig();

  await getStorageClient().removeObject(bucket, validateStorageKey(storageKey));
}

function normalizeExpiry(expiresInSeconds?: number): number {
  if (expiresInSeconds === undefined) {
    return DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS;
  }

  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    expiresInSeconds > MAX_PRESIGNED_URL_EXPIRY_SECONDS
  ) {
    throw new StorageValidationError(
      "La URL presignada no puede exceder 15 minutos",
    );
  }

  return expiresInSeconds;
}

/**
 * ¿Es una clave/prefijo seguro para pasarle al bucket? Sin `..`, sin barra
 * inicial, sin backslash ni caracteres de control. No exige un prefijo raíz:
 * además de `tramites/` (lo que sube la app) el bucket puede tener carpetas
 * cargadas por fuera (p. ej. `historico/2026/…` con rclone) que el explorador
 * de archivos debe poder listar y descargar.
 */
export function esClaveSegura(valor: string): boolean {
  if (!valor) return false;
  if (valor.startsWith("/") || valor.includes("\\")) return false;
  if (valor.split("/").some((segmento) => segmento === "..")) return false;
  if (/[ -]/.test(valor)) return false;
  return true;
}

function validateStorageKey(storageKey: string): string {
  if (!esClaveSegura(storageKey) || storageKey.endsWith("/")) {
    throw new StorageValidationError("storageKey invalido");
  }

  return storageKey;
}

function validateStoragePrefix(prefix: string): string {
  if (
    !prefix ||
    prefix.includes("..") ||
    prefix.startsWith("/") ||
    (!prefix.startsWith("tramites/") && !prefix.startsWith(DELETED_PREFIX))
  ) {
    throw new StorageValidationError("Prefijo de storage invalido");
  }

  return prefix;
}

function sanitizePathSegment(value: string, fieldName: string): string {
  const sanitized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!sanitized) {
    throw new StorageValidationError(`${fieldName} invalido`);
  }

  return sanitized;
}

function getFileExtension(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }

  const lastDotIndex = fileName.lastIndexOf(".");

  if (lastDotIndex < 0 || lastDotIndex === fileName.length - 1) {
    return undefined;
  }

  return fileName.slice(lastDotIndex + 1);
}

function normalizeExtension(extension: string): string {
  const normalized = extension.toLowerCase();

  return normalized === "jpeg" ? "jpg" : normalized;
}

function toPathTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
