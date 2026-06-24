/**
 * POST /api/borradores/[id]/siigo-sincronizar
 *
 * Consulta Siigo por el siigoDraftId del borrador y, si ya tiene consecutivo
 * definitivo asignado por un superior en el portal, marca el borrador como
 * FACTURADO + crea registro Factura (cartera).
 *
 * Idempotente: si el borrador ya está FACTURADO, devuelve los datos actuales.
 *
 * Rol: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { sincronizarFacturaDesdeSiigo } from "@/lib/siigo/sincronizar-factura-service";

type RouteParams = { params: Promise<{ id: string }> };

const STATUS_POR_TIPO = {
  estado: 409,
  config: 503,
  api: 502,
  db: 500,
} as const;

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  const result = await sincronizarFacturaDesdeSiigo(borradorId, session.user.id);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, tipo: result.tipo },
      { status: STATUS_POR_TIPO[result.tipo] },
    );
  }

  return jsonResponse({
    facturada: result.facturada,
    numFacturaSiigo: result.numFacturaSiigo,
    fechaFactura: result.fechaFactura,
    stampStatus: result.stampStatus,
    mensaje: result.mensaje,
  });
}
