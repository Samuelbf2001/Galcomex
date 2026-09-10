/**
 * PATCH /api/matrices/pago/[canalPago]
 *
 * Actualiza el costoFijo de una fila de MatrizPago (ADMIN).
 * OJO: no recalcula snapshots ya guardados (PagoTramite.costoBancario) — ver
 * src/lib/matrices/service.ts.
 */
import { CanalPago } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  CostoFijoNegativoError,
  MatrizPagoNoEncontradaError,
  actualizarCostoPago,
} from "@/lib/matrices/service";

type RouteContext = {
  params: Promise<{ canalPago: string }>;
};

const bodySchema = z.object({
  costoFijo: z.coerce
    .bigint()
    .refine((valor) => valor >= 0n, { message: "El costo no puede ser negativo" }),
});

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { canalPago: raw } = await context.params;
  if (!(Object.values(CanalPago) as string[]).includes(raw)) {
    return NextResponse.json(
      { error: `Canal de pago '${raw}' inválido` },
      { status: 400 },
    );
  }
  const canalPago = raw as CanalPago;

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
    const matrizPago = await actualizarCostoPago(
      canalPago,
      payload.costoFijo,
      session.user.id,
    );
    return jsonResponse({ matrizPago });
  } catch (error) {
    if (error instanceof MatrizPagoNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CostoFijoNegativoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
