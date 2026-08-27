/**
 * GET /api/liquidacion-lm?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Liquidación por lotes de la cuenta con el socio LM (Lucho).
 * Roles: ADMIN, REVISOR (contabilidad interna).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getLiquidacionLM } from "@/lib/liquidacion-lm/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { liquidacionLMQuerySchema } from "@/lib/validations/borradores";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const query = liquidacionLMQuerySchema.parse({
      desde: request.nextUrl.searchParams.get("desde") ?? undefined,
      hasta: request.nextUrl.searchParams.get("hasta") ?? undefined,
    });

    const liquidacion = await getLiquidacionLM({
      desde: query.desde,
      hasta: query.hasta,
    });

    return jsonResponse({ liquidacion });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }
}
