import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { actualizarPago, eliminarPago, getPagoConBeneficiario } from "@/lib/pagos/service";
import { actualizarPagoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string; pagoId: string }>;
};

/**
 * PATCH — edita un pago. Valor y canal de un pago con facturas o de un bloque
 * no se cambian (409 PAGO_NO_EDITABLE); en un bloque, concepto/fecha/
 * comprobantes se propagan a todo el bloque.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { pagoId } = await context.params;
    const payload = actualizarPagoSchema.parse(await request.json());

    await actualizarPago(pagoId, payload, session.user.id);
    const pago = await getPagoConBeneficiario(pagoId);

    return jsonResponse({ pago });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}

/** DELETE — borra un pago suelto (devuelve el saldo a sus facturas). Un pago de bloque: 409 PAGO_DE_BLOQUE. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { pagoId } = await context.params;

    await eliminarPago(pagoId, session.user.id);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
