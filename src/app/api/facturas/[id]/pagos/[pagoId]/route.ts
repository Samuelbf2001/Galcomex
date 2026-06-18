/**
 * DELETE /api/facturas/[id]/pagos/[pagoId] — Eliminar un PagoFactura (ADMIN)
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { eliminarPagoFactura } from "@/lib/cartera/service";
import { jsonResponse } from "@/lib/http/json";

type RouteParams = { params: Promise<{ id: string; pagoId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { pagoId } = await params;

  const result = await eliminarPagoFactura(pagoId, session.user.id);

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  return jsonResponse({ factura: result.factura, saldoNeto: result.saldoNeto });
}
