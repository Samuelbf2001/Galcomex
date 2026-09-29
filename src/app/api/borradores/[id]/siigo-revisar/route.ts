/**
 * POST /api/borradores/[id]/siigo-revisar — «Revisar en SIIGO».
 *
 * Para un envío INCIERTO (no sabemos si SIIGO creó la factura): con
 * siigoDraftId lo consulta en SIIGO y, si existe, lo deja ENVIADO; sin id le
 * dice al ADMIN qué buscar en el portal y habilita «Liberar para reenviar».
 * Ver `src/lib/siigo/resolver-envio-service.ts`.
 *
 * Sin cuerpo. Rol: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { revisarEnvioEnSiigo } from "@/lib/siigo/resolver-envio-service";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  try {
    const revision = await revisarEnvioEnSiigo(borradorId, session.user.id);
    return jsonResponse(revision);
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
