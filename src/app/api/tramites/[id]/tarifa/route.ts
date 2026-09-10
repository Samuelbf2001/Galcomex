import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { propuestaParaTramite } from "@/lib/tarifas/service";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET — ADMIN, REVISOR, OPERATIVO. Líneas que el tarifario vigente de la
 * empresa propone para este trámite, con lo que falta capturar para poder
 * calcular (CIF, contenedores…). Es una vista previa: no persiste nada.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    return jsonResponse({ propuesta: await propuestaParaTramite(id) });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
