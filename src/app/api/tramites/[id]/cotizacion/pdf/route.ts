/**
 * GET /api/tramites/[id]/cotizacion/pdf — la cotización / solicitud de fondos
 * del DO en PDF (B7). Roles: ADMIN, REVISOR, OPERATIVO. Necesita Node runtime
 * (react-pdf). Solo lectura.
 */

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { CotizacionIncompletaError, cotizacionDeTramite } from "@/lib/cotizacion/service";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { renderCotizacionPdf } from "@/lib/pdf/cotizacion-pdf";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const cotizacion = await cotizacionDeTramite(id);
    const pdf = await renderCotizacionPdf(cotizacion);

    const filename = `cotizacion-${cotizacion.tramite.consecutivo}.pdf`
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "");

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    });
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
