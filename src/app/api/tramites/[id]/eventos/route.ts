import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { eventosDeTramite, marcarEventosTramite } from "@/lib/eventos/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { marcarEventosSchema } from "@/lib/validations/eventos";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Eventos marcados en un trámite (M3).
 *
 * GET — ADMIN, REVISOR, OPERATIVO.
 * PUT — ADMIN, REVISOR, OPERATIVO: reemplaza el conjunto (la UI manda los checks
 *       completos). Exige la capacidad `eventos_facturables` de la empresa.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;
  return jsonResponse({ eventos: await eventosDeTramite(id) });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const { eventos } = marcarEventosSchema.parse(await request.json());
    await marcarEventosTramite({ tramiteId: id, eventos, usuarioId: session.user.id });

    return jsonResponse({ eventos: await eventosDeTramite(id) });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
