import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  DeshacerLiquidacionImposibleError,
  deshacerLiquidacion,
} from "@/lib/comisiones/deshacer-liquidacion";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { deshacerLiquidacionSchema } from "@/lib/validations/comisiones";

type RouteContext = { params: Promise<{ id: string; tramiteId: string }> };

/**
 * M3 — deshacer una liquidación de comisiones (B10): las comisiones ligadas al
 * «Otros» vuelven a "por facturar" y el «Otros» queda anulado (sin valor,
 * cerrado, "ANULADO: motivo").
 *
 * DELETE — solo ADMIN. Cuerpo `{ motivo }` (≥ 10 caracteres; también se acepta
 *          `?motivo=` por si el cliente HTTP no manda cuerpo en un DELETE).
 *          200 con lo que se deshizo. 404 si el «Otros» no es de la empresa o ya
 *          no tiene comisiones ligadas; 409 `DESHACER_LIQUIDACION_IMPOSIBLE` si
 *          ya tiene factura aprobada o emitida, envío a Siigo, estado de cobro o
 *          movimientos de plata.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id, tramiteId } = await context.params;
    const cuerpo: unknown = await request.json().catch(() => ({}));
    const deCuerpo =
      typeof cuerpo === "object" && cuerpo !== null && "motivo" in cuerpo
        ? (cuerpo as { motivo?: unknown }).motivo
        : undefined;
    const payload = deshacerLiquidacionSchema.parse({
      motivo: deCuerpo ?? request.nextUrl.searchParams.get("motivo") ?? undefined,
    });
    const resultado = await deshacerLiquidacion({
      empresaId: id,
      tramiteId,
      motivo: payload.motivo,
      usuarioId: session.user.id,
    });
    return jsonResponse(resultado);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (error instanceof DeshacerLiquidacionImposibleError) {
      return jsonResponse({ error: error.message, codigo: error.codigo }, { status: error.status });
    }
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
