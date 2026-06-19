import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  AnticipoNoEncontradoError,
  VerificarAnticipoPermisoError,
  verificarAnticipo,
} from "@/lib/anticipos/service";
import { verificarMovimientoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = verificarMovimientoSchema.parse(await request.json());

    const anticipo = await verificarAnticipo(id, payload.estado, session.user.rol);
    return jsonResponse({ anticipo });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (error instanceof AnticipoNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VerificarAnticipoPermisoError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
