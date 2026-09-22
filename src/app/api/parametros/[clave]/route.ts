/**
 * PATCH /api/parametros/[clave]
 *
 * Actualiza el valor de un Parametro genérico del sistema (ADMIN).
 * Los parámetros SIIGO_* (integración con Siigo) NO se editan aquí — ver
 * /api/configuracion/siigo/parametros y siigo-parametros.tsx.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  ParametroNoEncontradoError,
  ParametroSiigoProtegidoError,
  ParametroValorInvalidoError,
  actualizarParametro,
} from "@/lib/parametros/service";

type RouteContext = {
  params: Promise<{ clave: string }>;
};

const patchSchema = z.object({
  valor: z.string().trim().min(1, "El valor no puede estar vacío"),
});

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { clave } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let payload: z.infer<typeof patchSchema>;
  try {
    payload = patchSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    const parametro = await actualizarParametro(
      clave,
      payload.valor,
      session.user.id,
    );
    return jsonResponse({ parametro });
  } catch (error) {
    if (error instanceof ParametroNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ParametroValorInvalidoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ParametroSiigoProtegidoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
