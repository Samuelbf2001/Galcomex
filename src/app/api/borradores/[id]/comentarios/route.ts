/**
 * PUT /api/borradores/[id]/comentarios — Reemplaza los comentarios de cabecera
 * del borrador. Cada string es una fila descriptiva (formato Lucho).
 *
 * Rol: ADMIN, OPERATIVO o SOCIO (los SOCIO solo en trámites SOCIO_LM, validado en service).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { actualizarComentariosCabecera } from "@/lib/borradores/service";
import { validationError } from "@/lib/http/errors";
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
    throw error;
  }
}
