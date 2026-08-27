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

import { CategoriaDocumento, type Documento, Prisma, type Rol } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  createPresignedDownloadUrl,
  generateStorageKey,
  softDeleteStorageObject,
  validateStorageFile,
} from "@/lib/storage/service";
import { assertTramiteModificable } from "@/lib/tramites/guard";

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type SolicitarSubidaInput = {
  tramiteId: string;
  categoria: CategoriaDocumento;
  carpeta?: string;
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

export type ReemplazarDocumentoInput = {
  documentoId: string;
  usuarioId: string;
  rol: Rol;
  storageKey: string;
  nombreArchivo: string;
  mimeType: string;
  tamanoBytes: number;
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

/**
 * Documento no cuenta con permiso suficiente para eliminar o reemplazar,
 * según la matriz de roles (ver puedeEliminarDocumento / puedeReemplazarDocumento).
 */
export class DocumentoPermisoError extends Error {
  public readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "DocumentoPermisoError";
  }
}

// ─── Matriz de roles: eliminar/reemplazar documentos ─────────────────────────
// Decisión confirmada por el usuario (reunión 1-jul, confirmada 2026-08-26):
//  - ADMIN y REVISOR: eliminan y reemplazan cualquier documento.
//  - OPERATIVO: sube, y reemplaza SOLO documentos que él mismo subió
//    (Documento.subidoPorId). No puede eliminar.
//  - SOCIO: solo sube. No reemplaza ni elimina.

export function puedeEliminarDocumento(rol: Rol): boolean {
  return rol === "ADMIN" || rol === "REVISOR";
}

export function puedeReemplazarDocumento(
  rol: Rol,
  documento: { subidoPorId: string },
  usuarioId: string,
): boolean {
  if (rol === "ADMIN" || rol === "REVISOR") return true;
  if (rol === "OPERATIVO") return documento.subidoPorId === usuarioId;
  return false;
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
  COMPROBANTE_COMERCIO: ["comercio", "pse"],
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
  carpeta?: string;
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
    carpeta: input.carpeta,
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
    await assertTramiteModificable(tx, input.tramiteId);

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
 *
 * Solo ADMIN o REVISOR pueden eliminar (ver puedeEliminarDocumento). El
 * permiso no depende de datos del documento, así que se valida ANTES de
 * consultar la BD.
 */
export async function eliminarDocumento(
  documentoId: string,
  usuarioId: string,
  rol: Rol,
): Promise<void> {
  if (!puedeEliminarDocumento(rol)) {
    throw new DocumentoPermisoError(
      "No tienes permiso para eliminar documentos. Solo ADMIN o REVISOR pueden hacerlo.",
    );
  }

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
    await assertTramiteModificable(tx, doc.tramiteId);

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
 * Reemplaza el archivo de un documento EXISTENTE (mismo id) por uno nuevo ya
 * subido a MinIO (el cliente ya hizo el PUT prefirmado, igual que en el flujo
 * de subida normal — ver solicitarSubida()).
 *
 * Decisión de diseño (no hay migraciones de schema disponibles en esta tarea):
 * "reemplazar" ACTUALIZA el registro Documento en sitio (mismo id; nuevo
 * storageKey/nombreArchivo/mimeType/tamanoBytes) en lugar de hacer
 * "eliminar + subir uno nuevo". Motivo: Documento tiene relaciones ENTRANTES
 * (PagoTramite.soporteDocumento, PagoTramite.comprobanteComercio,
 * FacturaProveedor.documento) que apuntan por documentoId; crear un id nuevo
 * dejaría esas referencias apuntando al documento viejo ya marcado
 * eliminado=true. subidoPorId se conserva (representa la procedencia
 * original); quién reemplazó y cuándo queda registrado en el AuditLog
 * (antes/después). El archivo anterior en MinIO se mueve al prefijo
 * deleted/ con el mismo mecanismo que eliminarDocumento (no se pierde el
 * histórico).
 */
export async function reemplazarDocumento(
  input: ReemplazarDocumentoInput,
): Promise<Documento> {
  const doc = await prisma.documento.findUnique({
    where: { id: input.documentoId },
  });

  if (!doc) {
    throw new DocumentoNoEncontradoError(input.documentoId);
  }

  if (doc.eliminado) {
    throw new DocumentoYaEliminadoError(input.documentoId);
  }

  if (!puedeReemplazarDocumento(input.rol, doc, input.usuarioId)) {
    throw new DocumentoPermisoError(
      "No tienes permiso para reemplazar este documento. Solo quien lo subió, ADMIN o REVISOR pueden reemplazarlo.",
    );
  }

  const storageKeyAnterior = doc.storageKey;

  const actualizado = await prisma.$transaction(async (tx) => {
    await assertTramiteModificable(tx, doc.tramiteId);

    const updated = await tx.documento.update({
      where: { id: input.documentoId },
      data: {
        storageKey: input.storageKey,
        nombreArchivo: input.nombreArchivo,
        mimeType: input.mimeType,
        tamanoBytes: input.tamanoBytes,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Documento",
        entidadId: input.documentoId,
        accion: "REPLACE",
        usuarioId: input.usuarioId,
        tramiteId: doc.tramiteId,
        antes: normalizeSerializable(doc),
        despues: normalizeSerializable(updated),
      },
    });

    return updated;
  });

  // Soft-delete del archivo anterior en MinIO (fuera de la transacción de BD
  // para no bloquearla; igual que eliminarDocumento).
  try {
    await softDeleteStorageObject({ storageKey: storageKeyAnterior, deletedBy: input.usuarioId });
  } catch {
    // No revertir el reemplazo en BD; el objeto viejo puede limpiarse manualmente.
  }

  return actualizado;
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
