import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import {
  DocumentoNoEncontradoError,
  listarDocumentos,
  registrarDocumento,
  solicitarSubida,
} from "@/lib/documentos/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { StorageValidationError } from "@/lib/storage/service";
import {
  registrarDocumentoSchema,
  solicitarSubidaSchema,
} from "@/lib/validations/documentos";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  try {
    const documentosPorCategoria = await listarDocumentos(id);
    return jsonResponse({ documentos: documentosPorCategoria });
  } catch (error) {
    if (error instanceof DocumentoNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  try {
    const body: unknown = await request.json();

    if (!body || typeof body !== "object" || !("action" in body)) {
      return NextResponse.json({ error: "Se requiere el campo 'action'" }, { status: 400 });
    }

    const action = (body as Record<string, unknown>).action;

    if (action === "uploadUrl") {
      const payload = solicitarSubidaSchema.parse({ ...body, tramiteId: id });
      const result = await solicitarSubida({
        tramiteId: payload.tramiteId,
        categoria: payload.categoria,
        fileName: payload.fileName,
        contentType: payload.contentType,
        sizeBytes: payload.sizeBytes,
      });
      return jsonResponse({ uploadUrl: result }, { status: 201 });
    }

    if (action === "register") {
      const payload = registrarDocumentoSchema.parse(body);
      const documento = await registrarDocumento({
        tramiteId: id,
        categoria: payload.categoria,
        nombreArchivo: payload.nombreArchivo,
        storageKey: payload.storageKey,
        mimeType: payload.mimeType,
        tamanoBytes: payload.tamanoBytes,
        subidoPorId: session.user.id,
      });
      return jsonResponse({ documento }, { status: 201 });
    }

    return NextResponse.json({ error: "Accion no soportada" }, { status: 400 });
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
    throw error;
  }
}
