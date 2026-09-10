/**
 * PATCH /api/matrices/recaudo/[tipoRecaudo]
 *
 * Actualiza el costoFijo de una fila de MatrizRecaudo (ADMIN).
 * OJO: no recalcula snapshots ya guardados (Anticipo.costoRecaudo) — ver
 * src/lib/matrices/service.ts.
 */
import { TipoRecaudo } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  CostoFijoNegativoError,
  MatrizRecaudoNoEncontradaError,
  actualizarCostoRecaudo,
} from "@/lib/matrices/service";

type RouteContext = {
  params: Promise<{ tipoRecaudo: string }>;
};

const bodySchema = z.object({
  costoFijo: z.coerce
    .bigint()
    .refine((valor) => valor >= 0n, { message: "El costo no puede ser negativo" }),
});

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { tipoRecaudo: raw } = await context.params;
  if (!(Object.values(TipoRecaudo) as string[]).includes(raw)) {
    return NextResponse.json(
      { error: `Tipo de recaudo '${raw}' inválido` },
      { status: 400 },
    );
  }
  const tipoRecaudo = raw as TipoRecaudo;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let payload: z.infer<typeof bodySchema>;
  try {
    payload = bodySchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    const matrizRecaudo = await actualizarCostoRecaudo(
      tipoRecaudo,
      payload.costoFijo,
      session.user.id,
    );
    return jsonResponse({ matrizRecaudo });
  } catch (error) {
    if (error instanceof MatrizRecaudoNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CostoFijoNegativoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
