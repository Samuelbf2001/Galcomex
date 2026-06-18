import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  MatrizCanalNoEncontradoError,
  actualizarPago,
  eliminarPago,
  getPagoConBeneficiario,
} from "@/lib/pagos/service";
import { actualizarPagoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string; pagoId: string }>;
};

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
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (error instanceof MatrizCanalNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    throw error;
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { pagoId } = await context.params;

  await eliminarPago(pagoId, session.user.id);

  return new NextResponse(null, { status: 204 });
}
