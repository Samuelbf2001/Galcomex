import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { prisma } from "@/lib/db/prisma";
import {
  DocumentoNoEncontradoError,
  DocumentoPermisoError,
  DocumentoYaEliminadoError,
  eliminarDocumento,
  reemplazarDocumento,
  refrescarUrlDescarga,
} from "@/lib/documentos/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { StorageValidationError } from "@/lib/storage/service";
import { reemplazarDocumentoSchema } from "@/lib/validations/documentos";

type RouteContext = {
  params: Promise<{ id: string; documentoId: string }>;
};

/**
 * GET /api/tramites/[id]/documentos/[documentoId]
 * Devuelve una URL de descarga fresca para el documento (útil al expirar la anterior).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id, documentoId } = await context.params;

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  // El documento debe pertenecer al trámite de la ruta (evita IDOR por documentoId ajeno).
  const doc = await prisma.documento.findUnique({
    where: { id: documentoId },
    select: { tramiteId: true },
  });
  if (!doc || doc.tramiteId !== id) {
    return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  }

  try {
    const url = await refrescarUrlDescarga(documentoId);
    return jsonResponse({ url });
  } catch (error) {
    if (error instanceof DocumentoNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * DELETE /api/tramites/[id]/documentos/[documentoId]
 * Soft-delete del documento: eliminado=true en BD + mueve objeto en MinIO.
 *
 * Matriz de roles: solo ADMIN o REVISOR pueden eliminar (ver
 * puedeEliminarDocumento en el service). OPERATIVO y SOCIO quedan fuera aquí
 * a nivel de ruta (403 temprano) y el service vuelve a validarlo (defensa en
 * profundidad, por si esta función se invoca desde otro caller).
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id, documentoId } = await context.params;

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  // El documento debe pertenecer al trámite de la ruta (evita IDOR por documentoId ajeno).
  const doc = await prisma.documento.findUnique({
    where: { id: documentoId },
    select: { tramiteId: true },
  });
  if (!doc || doc.tramiteId !== id) {
    return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  }

  try {
    await eliminarDocumento(documentoId, session.user.id, session.user.rol);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof DocumentoNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DocumentoYaEliminadoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DocumentoPermisoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }
    throw error;
  }
}

/**
 * PUT /api/tramites/[id]/documentos/[documentoId]
 * Reemplaza el archivo de un documento existente (mismo id) por uno nuevo ya
 * subido a MinIO. El cliente primero pide una URL prefirmada con
 * POST /api/tramites/[id]/documentos { action: "uploadUrl", ... } (mismo
 * flujo que subir), hace el PUT directo a MinIO, y luego llama a este
 * endpoint con el storageKey resultante para confirmar el reemplazo.
 *
 * Matriz de roles: ADMIN/REVISOR reemplazan cualquier documento; OPERATIVO
 * solo el que él mismo subió (Documento.subidoPorId); SOCIO no reemplaza.
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id, documentoId } = await context.params;

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  // El documento debe pertenecer al trámite de la ruta (evita IDOR por documentoId ajeno).
  const doc = await prisma.documento.findUnique({
    where: { id: documentoId },
    select: { tramiteId: true },
  });
  if (!doc || doc.tramiteId !== id) {
    return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  }

  try {
    const body: unknown = await request.json();
    const payload = reemplazarDocumentoSchema.parse(body);

    const documento = await reemplazarDocumento({
      documentoId,
      usuarioId: session.user.id,
      rol: session.user.rol,
      storageKey: payload.storageKey,
      nombreArchivo: payload.nombreArchivo,
      mimeType: payload.mimeType,
      tamanoBytes: payload.tamanoBytes,
    });

    return jsonResponse({ documento });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (error instanceof StorageValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DocumentoNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DocumentoYaEliminadoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DocumentoPermisoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }
    throw error;
  }
}
