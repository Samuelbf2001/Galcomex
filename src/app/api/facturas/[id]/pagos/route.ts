/**
 * GET  /api/facturas/[id]/pagos  — Lista de PagoFactura de una factura (ADMIN/REVISOR)
 * POST /api/facturas/[id]/pagos  — Registrar abono o devolución (ADMIN)
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  getFacturaConPagos,
  registrarPagoFacturaAbono,
} from "@/lib/cartera/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { registrarPagoFacturaSchema } from "@/lib/validations/cartera";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id: facturaId } = await params;

  const factura = await getFacturaConPagos(facturaId);

  if (!factura) {
    return NextResponse.json({ error: `Factura ${facturaId} no encontrada` }, { status: 404 });
  }

  return jsonResponse({ factura });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id: facturaId } = await params;

  try {
    const payload = registrarPagoFacturaSchema.parse(await request.json());

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: payload.destino,
      tipo: payload.tipo,
      monto: payload.monto,
      fecha: payload.fecha,
      tipoRecaudo: payload.tipoRecaudo,
      canalPago: payload.canalPago,
      comprobanteKey: payload.comprobanteKey,
      verificadoBanco: payload.verificadoBanco,
      usuarioId: session.user.id,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }

    return jsonResponse(
      { pago: result.pago, factura: result.factura, saldoNeto: result.saldoNeto },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
