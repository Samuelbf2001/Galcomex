import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getCuentaCorriente, registrarCompensacion } from "@/lib/cuenta-corriente/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { compensacionSchema } from "@/lib/validations/cuenta-corriente";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST — ADMIN. Cruce de saldos (M5): salda el mismo importe en las dos puntas
 * de la cuenta corriente sin que se mueva plata. Devuelve la cuenta actualizada
 * y el id del cruce (para deshacerlo).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = compensacionSchema.parse(await request.json());
    const resultado = await registrarCompensacion({ ...payload, empresaId: id, usuarioId: session.user.id });
    const cuenta = await getCuentaCorriente(id);

    return jsonResponse({ compensacion: resultado, cuenta }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
