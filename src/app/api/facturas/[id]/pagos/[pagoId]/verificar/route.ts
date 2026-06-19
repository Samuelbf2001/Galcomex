import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  VerificarPagoFacturaPermisoError,
  verificarPagoFactura,
} from "@/lib/cartera/service";
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

    const result = await verificarPagoFactura(pagoId, payload.estado, session.user.rol);

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }

    return jsonResponse({ pago: result.pago });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (error instanceof VerificarPagoFacturaPermisoError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
