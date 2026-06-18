import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import {
  DocumentoNoEncontradoError,
  DocumentoYaEliminadoError,
  eliminarDocumento,
  refrescarUrlDescarga,
} from "@/lib/documentos/service";
import { jsonResponse } from "@/lib/http/json";

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

  const { documentoId } = await context.params;

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
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { documentoId } = await context.params;

  try {
    await eliminarDocumento(documentoId, session.user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof DocumentoNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DocumentoYaEliminadoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
