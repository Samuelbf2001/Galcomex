import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { VerificarMovimientoPermisoError, verificarPago } from "@/lib/pagos/service";
import { verificarMovimientoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string; pagoId: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { pagoId } = await context.params;
    const payload = verificarMovimientoSchema.parse(await request.json());

    const pago = await verificarPago(pagoId, payload.estado, session.user.rol);
    return jsonResponse({ pago });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (error instanceof VerificarMovimientoPermisoError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
