import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { crearTarifario, listarTarifarios } from "@/lib/tarifas/service";
import { tarifarioSchema } from "@/lib/validations/tarifas";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Tarifarios de una empresa (M2).
 *
 * GET  — ADMIN, REVISOR, OPERATIVO: todas las versiones, con ítems.
 * POST — ADMIN: crea un tarifario BORRADOR (exige la capacidad `tarifario_propio`).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;
  const tarifarios = await listarTarifarios(id);

  return jsonResponse({ tarifarios });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = tarifarioSchema.parse(await request.json());
    const tarifario = await crearTarifario({ ...payload, empresaId: id, usuarioId: session.user.id });

    return jsonResponse({ tarifario }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
