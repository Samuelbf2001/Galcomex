import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import type { AuthSession } from "@/lib/auth/auth";
import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { prisma } from "@/lib/db/prisma";
import {
  crearEnlaceDocumento,
  DocumentoNoEncontradoParaEnlaceError,
  EnlaceNoEncontradoError,
  EnlacePermisoError,
  obtenerEnlaceActivo,
  revocarEnlace,
} from "@/lib/documentos/enlaces";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = {
  params: Promise<{ id: string; documentoId: string }>;
};

type DocumentoEnlaceComoDTO = {
  id: string;
  url: string;
  expiraEn: string;
  revocado: boolean;
  createdAt: string;
};

const revocarBodySchema = z.object({ enlaceId: z.string().min(1).optional() }).optional();

function buildEnlaceDTO(
  enlace: { id: string; token: string; expiraEn: Date; revocado: boolean; createdAt: Date },
  origin: string,
): DocumentoEnlaceComoDTO {
  return {
    id: enlace.id,
    url: `${origin}/compartir/${enlace.token}`,
    expiraEn: enlace.expiraEn.toISOString(),
    revocado: enlace.revocado,
    createdAt: enlace.createdAt.toISOString(),
  };
}

/**
 * Resuelve el gate IDOR compartido por POST y DELETE: sesión con rol
 * permitido + trámite accesible + documento perteneciente al trámite de la
 * URL (mismo patrón que las rutas vecinas de documentos).
 */
async function resolverAcceso(
  id: string,
  documentoId: string,
): Promise<AuthSession | NextResponse> {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const doc = await prisma.documento.findUnique({
    where: { id: documentoId },
    select: { tramiteId: true },
  });
  if (!doc || doc.tramiteId !== id) {
    return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  }

  return session;
}

/**
 * POST /api/tramites/[id]/documentos/[documentoId]/enlace
 * Crea (o devuelve el ya existente) enlace público para compartir el
 * documento. Idempotente: si ya hay un enlace activo, no crea uno nuevo.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, documentoId } = await context.params;
  const acceso = await resolverAcceso(id, documentoId);
  if (acceso instanceof NextResponse) {
    return acceso;
  }

  try {
    const activoAntes = await obtenerEnlaceActivo(documentoId);
    const enlace = await crearEnlaceDocumento(documentoId, acceso.user.id, acceso.user.rol);
    const status = activoAntes ? 200 : 201;

    return jsonResponse({ enlace: buildEnlaceDTO(enlace, request.nextUrl.origin) }, { status });
  } catch (error) {
    if (error instanceof DocumentoNoEncontradoParaEnlaceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EnlacePermisoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * DELETE /api/tramites/[id]/documentos/[documentoId]/enlace
 * Revoca un enlace público. Body opcional { enlaceId }; si se omite, revoca
 * el enlace activo actual del documento (si existe).
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id, documentoId } = await context.params;
  const acceso = await resolverAcceso(id, documentoId);
  if (acceso instanceof NextResponse) {
    return acceso;
  }

  try {
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = revocarBodySchema.parse(rawBody ?? undefined);

    let enlaceId = parsed?.enlaceId;

    if (!enlaceId) {
      const activo = await obtenerEnlaceActivo(documentoId);
      if (!activo) {
        return NextResponse.json(
          { error: "No hay un enlace activo para este documento" },
          { status: 404 },
        );
      }
      enlaceId = activo.id;
    } else {
      // IDOR: el enlaceId pasado por el cliente debe pertenecer a ESTE documento.
      const enlace = await prisma.documentoEnlace.findUnique({
        where: { id: enlaceId },
        select: { documentoId: true },
      });
      if (!enlace || enlace.documentoId !== documentoId) {
        return NextResponse.json({ error: "Enlace no encontrado" }, { status: 404 });
      }
    }

    await revocarEnlace(enlaceId, acceso.user.id, acceso.user.rol);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (error instanceof EnlaceNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EnlacePermisoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
