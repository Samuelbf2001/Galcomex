import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { duplicarTarifario } from "@/lib/tarifas/service";
import { tarifarioDuplicarSchema } from "@/lib/validations/tarifas";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST — ADMIN. Nueva versión BORRADOR con vigencia nueva y, opcionalmente,
 * incremento porcentual (IPC) redondeado a `redondeoA` (1.000 por defecto) o
 * copia a otra empresa (`empresaDestinoId`).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = tarifarioDuplicarSchema.parse(await request.json());
    const tarifario = await duplicarTarifario(id, payload, session.user.id);

    return jsonResponse({ tarifario }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
