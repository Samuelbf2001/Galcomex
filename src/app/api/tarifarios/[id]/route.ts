import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarTarifario, eliminarTarifario, getTarifario } from "@/lib/tarifas/service";
import { tarifarioUpdateSchema } from "@/lib/validations/tarifas";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Un tarifario (M2).
 *
 * GET    — ADMIN, REVISOR, OPERATIVO.
 * PATCH  — ADMIN: nombre y notas en cualquier estado; alcance y vigencia solo en BORRADOR.
 * DELETE — ADMIN: solo BORRADOR.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    return jsonResponse({ tarifario: await getTarifario(id) });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = tarifarioUpdateSchema.parse(await request.json());
    const tarifario = await actualizarTarifario(id, payload, session.user.id);

    return jsonResponse({ tarifario });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    await eliminarTarifario(id, session.user.id);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
