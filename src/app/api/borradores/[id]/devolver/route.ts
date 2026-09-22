/**
 * POST /api/borradores/[id]/devolver — El revisor devuelve el borrador con una
 * observación: el estado vuelve a BORRADOR, la observación queda en la ficha y
 * Camila recibe un aviso por WhatsApp.
 *
 * Roles: ADMIN y REVISOR (es la contraparte de "Aprobar borrador").
 *
 * El esquema Zod se declara aquí —como en la ruta hermana `comentarios`— para
 * no meter un ciclo de imports entre `lib/validations/borradores.ts` y
 * `lib/borradores/devolver.ts`; los límites de longitud sí salen del servicio,
 * que es quien los vuelve a validar.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import type { Rol } from "@/lib/auth/auth";
import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import {
  OBSERVACION_MAX,
  OBSERVACION_MIN,
  ROLES_DEVOLUCION,
  devolverBorrador,
} from "@/lib/borradores/devolver";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteParams = { params: Promise<{ id: string }> };

const payloadSchema = z.object({
  observacion: z
    .string()
    .trim()
    .min(OBSERVACION_MIN, `La observación debe tener al menos ${OBSERVACION_MIN} caracteres`)
    .max(OBSERVACION_MAX, `La observación no puede superar ${OBSERVACION_MAX} caracteres`),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(ROLES_DEVOLUCION);
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
    const { observacion } = payloadSchema.parse(body);
    const resultado = await devolverBorrador({
      borradorId,
      usuarioId: session.user.id,
      rol: session.user.rol as Rol,
      observacion,
    });

    return jsonResponse({
      borrador: resultado.borrador,
      observacion: resultado.observacion,
      consecutivo: resultado.consecutivo,
    });
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
