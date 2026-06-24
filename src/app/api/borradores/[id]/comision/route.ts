/**
 * PATCH /api/borradores/[id]/comision — Actualiza la comisión del borrador.
 * IVA se recalcula desde tasaIva; total y saldos se propagan vía recalculo.
 *
 * Roles: ADMIN, SOCIO (mismo gate que las líneas manuales del borrador).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { actualizarComisionBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarComisionPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "SOCIO"]);
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
    const payload = actualizarComisionPayloadSchema.parse(body);
    const result = await actualizarComisionBorrador(
      borradorId,
      payload.comision,
      session.user.id,
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }
    return jsonResponse({ borrador: result.borrador });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }
}
