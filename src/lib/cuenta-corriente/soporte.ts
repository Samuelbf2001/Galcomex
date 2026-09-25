/**
 * Soporte (PDF/imagen) de una factura de proveedor registrada en la cuenta
 * corriente de una empresa (M5, "Registrar factura de <proveedor>").
 *
 * Reusa el patrón de subida de la bodega (`lib/storage/service.ts`): el
 * cliente pide una URL prefirmada, sube el archivo directo, y solo entonces
 * registra el movimiento con la clave resultante. Clave propia (no
 * `tramites/…`, porque una factura de proveedor por fuera de trámite no
 * pertenece a ninguno): `empresas/<empresaId>/cuenta/<uuid>-<nombre>`.
 */
import { randomUUID } from "node:crypto";

import { createPresignedUploadUrlForKey } from "@/lib/storage/service";

/** Subconjunto de `ALLOWED_STORAGE_FILE_TYPES`: solo lo que trae una factura. */
const TIPOS_SOPORTE_CUENTA: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export const MAX_SOPORTE_CUENTA_BYTES = 10 * 1024 * 1024;

export class SoporteCuentaValidationError extends Error {
  public readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "SoporteCuentaValidationError";
  }
}

function sanearNombreArchivo(nombre: string): string {
  const sinAcentos = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const limpio = sinAcentos
    .replace(/[^a-zA-Z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return limpio || "archivo";
}

export function generarClaveSoporteCuenta(empresaId: string, fileName: string): string {
  return `empresas/${empresaId}/cuenta/${randomUUID()}-${sanearNombreArchivo(fileName)}`;
}

export async function solicitarSubidaSoporteCuenta(input: {
  empresaId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ uploadUrl: string; key: string }> {
  if (!Object.hasOwn(TIPOS_SOPORTE_CUENTA, input.contentType)) {
    throw new SoporteCuentaValidationError("Solo se admiten PDF, JPG o PNG.");
  }

  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new SoporteCuentaValidationError("El tamaño del archivo debe ser mayor a cero.");
  }

  if (input.sizeBytes > MAX_SOPORTE_CUENTA_BYTES) {
    throw new SoporteCuentaValidationError("El archivo supera el máximo permitido de 10MB.");
  }

  const storageKey = generarClaveSoporteCuenta(input.empresaId, input.fileName);
  const resultado = await createPresignedUploadUrlForKey({
    storageKey,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  return { uploadUrl: resultado.url, key: resultado.storageKey };
}
