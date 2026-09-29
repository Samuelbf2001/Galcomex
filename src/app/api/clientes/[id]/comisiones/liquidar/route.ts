import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { ComisionYaLiquidadaError, liquidarComisiones } from "@/lib/comisiones/liquidacion";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { liquidarComisionesSchema } from "@/lib/validations/comisiones";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * B10 — "Facturar comisiones" de la ficha de la empresa que paga (LTRANS).
 *
 * POST — solo ADMIN (crea el «Otros» que después se manda a facturar).
 *        `{ comisionIds: string[], ciudad?: Ciudad }` → 201 con el «Otros»
 *        creado y el total sin IVA. Las comisiones quedan ligadas a él.
 *        409 `COMISION_YA_LIQUIDADA` si otra persona ya facturó alguna.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = liquidarComisionesSchema.parse(await request.json());
    const resultado = await liquidarComisiones({
      empresaId: id,
      comisionIds: payload.comisionIds,
      ciudad: payload.ciudad,
      usuarioId: session.user.id,
    });
    return jsonResponse(resultado, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (error instanceof ComisionYaLiquidadaError) {
      return jsonResponse({ error: error.message, codigo: error.codigo }, { status: error.status });
    }
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
