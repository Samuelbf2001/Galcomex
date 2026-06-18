/**
 * Servicio de documentos del trámite — Galcomex
 * A2-T3: Repositorio documental por DO.
 *
 * Orquesta la capa de persistencia (modelo Documento en BD) con las
 * primitivas de storage (MinIO) ya existentes en src/lib/storage/.
 *
 * IMPORTANTE: Este servicio NO sube archivos. El cliente sube directamente
 * a MinIO usando la URL prefirmada obtenida con solicitarSubida().
 */

import { CategoriaDocumento, type Documento, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  createPresignedDownloadUrl,
  generateStorageKey,
  softDeleteStorageObject,
  validateStorageFile,
} from "@/lib/storage/service";

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type SolicitarSubidaInput = {
  tramiteId: string;
  categoria: CategoriaDocumento;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type SolicitarSubidaResult = {
  storageKey: string;
  uploadUrl: string;
  method: "PUT";
  contentType: string;
  maxSizeBytes: number;
  expiresInSeconds: number;
};

export type RegistrarDocumentoInput = {
  tramiteId: string;
  categoria: CategoriaDocumento;
  nombreArchivo: string;
  storageKey: string;
  mimeType: string;
  tamanoBytes: number;
  subidoPorId: string;
};

export type DocumentoConUrl = Documento & {
  downloadUrl: string;
  subidoPor: { id: string; name: string };
};

export type DocumentosPorCategoria = Record<string, DocumentoConUrl[]>;

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class DocumentoNoEncontradoError extends Error {
  public readonly status = 404;

  constructor(documentoId: string) {
    super(`Documento '${documentoId}' no encontrado`);
    this.name = "DocumentoNoEncontradoError";
  }
}

export class DocumentoYaEliminadoError extends Error {
  public readonly status = 409;

  constructor(documentoId: string) {
    super(`Documento '${documentoId}' ya fue eliminado`);
    this.name = "DocumentoYaEliminadoError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORIA_KEYWORDS: Record<CategoriaDocumento, string[]> = {
  FACTURA_COMERCIAL: ["factura comercial"],
  BL: ["bl", "bill of lading"],
  PACKING_LIST: ["packing"],
  DECLARACION_DIAN: ["dian"],
  SOPORTE_FACTURACION: ["soporte"],
  FOTO_RECONOCIMIENTO: ["foto", "reconocimiento"],
  COMPROBANTE_BANCARIO: ["comprobante", "bancario"],
  FACTURA_PROVEEDOR: ["factura proveedor"],
  OTRO: [],
};

function matchesCategoria(descripcion: string, categoria: CategoriaDocumento): boolean {
  const keywords = CATEGORIA_KEYWORDS[categoria] ?? [];
  const lower = descripcion.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/**
 * Importa dinámicamente la función createPresignedUploadUrl para no depender
 * del cliente MinIO en tests de integración de BD.
 * En tests se puede interceptar con vi.mock().
 */
async function getUploadUrl(input: {
  consecutivo: string;
  categoria: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ storageKey: string; url: string; method: "PUT"; contentType: string; maxSizeBytes: number; expiresInSeconds: number }> {
  const { createPresignedUploadUrl } = await import("@/lib/storage/service");
  return createPresignedUploadUrl(input);
}

// ─── Funciones del servicio ───────────────────────────────────────────────────

/**
 * Genera una URL prefirmada de subida para un archivo.
 * NO crea el registro Documento todavía — eso ocurre en registrarDocumento()
 * una vez que el cliente haya subido el archivo a MinIO.
 */
export async function solicitarSubida(
  input: SolicitarSubidaInput,
): Promise<SolicitarSubidaResult> {
  // Validar tipo y tamaño ANTES de llamar a MinIO
  validateStorageFile({
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  // Obtener el consecutivo del trámite para el path de storage
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: input.tramiteId },
    select: { consecutivo: true },
  });

  if (!tramite) {
    throw new DocumentoNoEncontradoError(input.tramiteId);
  }

  const result = await getUploadUrl({
    consecutivo: tramite.consecutivo,
    categoria: input.categoria,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  return {
    storageKey: result.storageKey,
    uploadUrl: result.url,
    method: "PUT",
    contentType: result.contentType,
    maxSizeBytes: result.maxSizeBytes,
    expiresInSeconds: result.expiresInSeconds,
  };
}

/**
 * Crea el registro Documento en BD después de que el cliente haya subido
 * el archivo directamente a MinIO.
 * Genera AuditLog con snapshot del documento creado.
 */
export async function registrarDocumento(
  input: RegistrarDocumentoInput,
): Promise<Documento> {
  return prisma.$transaction(async (tx) => {
    const documento = await tx.documento.create({
      data: {
        tramiteId: input.tramiteId,
        categoria: input.categoria,
        nombreArchivo: input.nombreArchivo,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        tamanoBytes: input.tamanoBytes,
        subidoPorId: input.subidoPorId,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Documento",
        entidadId: documento.id,
        accion: "CREATE",
        usuarioId: input.subidoPorId,
        tramiteId: input.tramiteId,
        despues: normalizeSerializable(documento),
      },
    });

    // Auto-marcar ítem del checklist que coincida con esta categoría
    if (input.categoria !== "OTRO") {
      const itemsPendientes = await tx.checklistItem.findMany({
        where: { tramiteId: input.tramiteId, recibido: false },
      });
      const ahora = new Date();
      for (const item of itemsPendientes) {
        if (matchesCategoria(item.descripcion, input.categoria)) {
          await tx.checklistItem.update({
            where: { id: item.id },
            data: { recibido: true, validadoPorId: input.subidoPorId, fechaValidacion: ahora },
          });
        }
      }
    }

    return documento;
  });
}

/**
 * Lista los documentos no eliminados de un trámite, agrupados por categoría.
 * Cada documento incluye una URL prefirmada de descarga (expira ≤ 15 min).
 * Si MinIO no está disponible (ej. tests), la URL se omite con gracia.
 */
export async function listarDocumentos(
  tramiteId: string,
): Promise<DocumentosPorCategoria> {
  const documentos = await prisma.documento.findMany({
    where: { tramiteId, eliminado: false },
    include: {
      subidoPor: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const result: DocumentosPorCategoria = {};

  for (const doc of documentos) {
    let downloadUrl = "";

    try {
      const presigned = await createPresignedDownloadUrl({ storageKey: doc.storageKey });
      downloadUrl = presigned.url;
    } catch {
      // MinIO no disponible: devolver URL vacía (el UI manejará el caso)
      downloadUrl = "";
    }

    const categoria = doc.categoria as string;
    if (!result[categoria]) {
      result[categoria] = [];
    }

    result[categoria].push({ ...doc, downloadUrl });
  }

  return result;
}

/**
 * Elimina lógicamente un documento (eliminado=true) y mueve el objeto
 * en MinIO al prefijo deleted/.
 * Genera AuditLog del soft-delete.
 */
export async function eliminarDocumento(
  documentoId: string,
  usuarioId: string,
): Promise<void> {
  const doc = await prisma.documento.findUnique({
    where: { id: documentoId },
  });

  if (!doc) {
    throw new DocumentoNoEncontradoError(documentoId);
  }

  if (doc.eliminado) {
    throw new DocumentoYaEliminadoError(documentoId);
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.documento.update({
      where: { id: documentoId },
      data: { eliminado: true },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Documento",
        entidadId: documentoId,
        accion: "DELETE",
        usuarioId,
        tramiteId: doc.tramiteId,
        antes: normalizeSerializable(doc),
        despues: normalizeSerializable(updated),
      },
    });
  });

  // Soft-delete en MinIO (fuera de la transacción de BD para no bloquearla)
  try {
    await softDeleteStorageObject({ storageKey: doc.storageKey, deletedBy: usuarioId });
  } catch {
    // No revertir el soft-delete de BD; el objeto MinIO puede limpiarse manualmente
  }
}

/**
 * Obtiene una URL de descarga fresca para un documento específico.
 * Útil para refrescar URLs expiradas en el frontend.
 */
export async function refrescarUrlDescarga(documentoId: string): Promise<string> {
  const doc = await prisma.documento.findUnique({
    where: { id: documentoId },
    select: { storageKey: true, eliminado: true },
  });

  if (!doc || doc.eliminado) {
    throw new DocumentoNoEncontradoError(documentoId);
  }

  const presigned = await createPresignedDownloadUrl({ storageKey: doc.storageKey });
  return presigned.url;
}

/**
 * Genera un storageKey para uso en pruebas o pre-validación sin llamar a MinIO.
 * Envuelve generateStorageKey del storage service.
 */
export function generarStorageKey(input: {
  consecutivo: string;
  categoria: string;
  fileName: string;
  contentType: string;
}): string {
  return generateStorageKey(input);
}
