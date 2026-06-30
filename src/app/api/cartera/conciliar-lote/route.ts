/**
 * POST /api/cartera/conciliar-lote — Conciliación batch de múltiples facturas (ADMIN)
 *
 * Cada ítem se procesa en su propia transacción (ejecución parcial).
 * Status codes:
 *   201 — todos los ítems exitosos
 *   207 — parcial (al menos uno ok y al menos uno con error)
 *   422 — todos los ítems fallaron
 *   400 — Zod validation error
 *   403 — rol incorrecto
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { conciliarLoteFacturas } from "@/lib/cartera/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { conciliarLoteSchema } from "@/lib/validations/cartera";

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = conciliarLoteSchema.parse(await request.json());

    const result = await conciliarLoteFacturas({
      items: payload.items.map((i) => ({
        facturaId: i.facturaId,
        destino: i.destino,
        tipo: i.tipo,
        monto: i.monto,
        fecha: i.fecha,
        tipoRecaudo: i.tipoRecaudo,
        canalPago: i.canalPago,
        comprobanteKey: i.comprobanteKey,
        verificadoBanco: i.verificadoBanco,
      })),
      usuarioId: session.user.id,
    });

    const status =
      result.failed === 0 ? 201 : result.ok === 0 ? 422 : 207;

    return jsonResponse(result, { status });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
