import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { cambiarEstadoTarifario } from "@/lib/tarifas/service";
import { tarifarioEstadoSchema } from "@/lib/validations/tarifas";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST — ADMIN. `{ estado: "VIGENTE" }` publica el borrador y reemplaza al
 * vigente anterior del mismo alcance; `{ estado: "VENCIDO" }` lo cierra.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const { estado } = tarifarioEstadoSchema.parse(await request.json());
    const tarifario = await cambiarEstadoTarifario(id, estado, session.user.id);

    return jsonResponse({ tarifario });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
