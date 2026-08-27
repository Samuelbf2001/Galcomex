/**
 * PUT /api/borradores/[id]/comentarios — Reemplaza los comentarios de cabecera
 * del borrador. Cada string es una fila descriptiva (formato Lucho).
 *
 * Rol: ADMIN, OPERATIVO o SOCIO (los SOCIO solo en trámites SOCIO_LM, validado en service).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { actualizarComentariosCabecera } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteParams = { params: Promise<{ id: string }> };

const payloadSchema = z.object({
  comentarios: z.array(z.string().max(500)).max(20),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "OPERATIVO", "SOCIO"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId } = await params;

  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: { tramiteId: true },
  });
  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  const permiso = await resolverTramiteConPermiso(borrador.tramiteId, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    const { comentarios } = payloadSchema.parse(body);
    const result = await actualizarComentariosCabecera(borradorId, comentarios, session.user.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }
    return jsonResponse({ borrador: result.borrador });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }
    throw error;
  }
}
