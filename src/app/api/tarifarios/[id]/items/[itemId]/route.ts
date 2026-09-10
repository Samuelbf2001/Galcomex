import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarItemTarifario, eliminarItemTarifario } from "@/lib/tarifas/service";
import { tarifaItemUpdateSchema } from "@/lib/validations/tarifas";

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

/** PATCH — ADMIN: edita un ítem (solo tarifario BORRADOR). Devuelve el tarifario completo. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id, itemId } = await context.params;
    const payload = tarifaItemUpdateSchema.parse(await request.json());
    const tarifario = await actualizarItemTarifario(id, itemId, payload, session.user.id);

    return jsonResponse({ tarifario });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}

/** DELETE — ADMIN: quita un ítem (solo tarifario BORRADOR). Devuelve el tarifario completo. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id, itemId } = await context.params;
    const tarifario = await eliminarItemTarifario(id, itemId, session.user.id);

    return jsonResponse({ tarifario });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
