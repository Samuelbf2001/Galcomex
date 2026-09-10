import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { eliminarCompensacion, getCuentaCorriente } from "@/lib/cuenta-corriente/service";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string; compensacionId: string }> };

/** DELETE — ADMIN. Deshace un cruce de saldos: retira sus dos puntas. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id, compensacionId } = await context.params;
    await eliminarCompensacion(id, compensacionId, session.user.id);

    return jsonResponse({ cuenta: await getCuentaCorriente(id) });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
