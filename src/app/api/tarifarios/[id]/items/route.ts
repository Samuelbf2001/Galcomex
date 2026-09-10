import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { agregarItemTarifario } from "@/lib/tarifas/service";
import { tarifaItemSchema } from "@/lib/validations/tarifas";

type RouteContext = { params: Promise<{ id: string }> };

/** POST — ADMIN: agrega un ítem a un tarifario BORRADOR. Devuelve el tarifario completo. */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = tarifaItemSchema.parse(await request.json());
    const tarifario = await agregarItemTarifario(id, payload, session.user.id);

    return jsonResponse({ tarifario }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
