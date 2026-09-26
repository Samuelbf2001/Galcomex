import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { comisionesDeEmpresa } from "@/lib/comisiones/service";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Comisiones por contenedor que esta empresa le debe a Galcomex (ficha de
 * LTRANS): DOs con contenedores comisionables, valor por contenedor y totales
 * con IVA. Todavía no hay facturación de comisiones: todo está "por facturar".
 *
 * GET — ADMIN y REVISOR (los mismos roles que ven cartera).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    return jsonResponse(await comisionesDeEmpresa(id));
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
