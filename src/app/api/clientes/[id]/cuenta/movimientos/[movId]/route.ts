import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { eliminarMovimientoCuenta, getCuentaCorriente } from "@/lib/cuenta-corriente/service";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string; movId: string }> };

/**
 * DELETE — ADMIN. Quita un movimiento manual registrado por error (factura de
 * contraparte, comisión o ajuste). Los que son parte de un cruce se deshacen
 * con `DELETE …/cuenta/compensaciones/[compensacionId]`, no con esta ruta.
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id, movId } = await context.params;
    await eliminarMovimientoCuenta(id, movId, session.user.id);

    return jsonResponse({ cuenta: await getCuentaCorriente(id) });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
