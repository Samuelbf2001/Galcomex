import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { CotizacionIncompletaError, cotizacionDeTramite } from "@/lib/cotizacion/service";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * B7 — cotización / solicitud de fondos del DO en JSON: conceptos con su IVA,
 * terceros, 4x1000, ReteIVA, total a girar, valor para la orden de compra y la
 * nota de la agencia. Es la misma cuenta que la factura de venta. Solo lectura.
 *
 * GET — ADMIN, REVISOR, OPERATIVO (los mismos que ven `GET /api/tramites/[id]/tarifa`).
 *       422 `COTIZACION_INCOMPLETA` si no hay tarifa o faltan datos del DO.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    return jsonResponse({ cotizacion: await cotizacionDeTramite(id) });
  } catch (error) {
    if (error instanceof CotizacionIncompletaError) {
      return jsonResponse(
        { error: error.message, codigo: error.codigo, pendientes: error.pendientes },
        { status: error.status },
      );
    }
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
