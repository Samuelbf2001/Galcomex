/**
 * GET /api/ingresos?clienteId=&desde=&hasta=
 *
 * Vista unificada de Anticipos + Abonos de factura + Devoluciones.
 * Saldo de caja corrido por cliente.
 * Rol ADMIN/REVISOR.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getIngresos } from "@/lib/ingresos/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { ingresosQuerySchema } from "@/lib/validations/cartera";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const params = ingresosQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      desde: request.nextUrl.searchParams.get("desde") ?? undefined,
      hasta: request.nextUrl.searchParams.get("hasta") ?? undefined,
    });

    const ingresos = await getIngresos({
      clienteId: params.clienteId,
      desde: params.desde,
      hasta: params.hasta,
    });

    return jsonResponse({ ingresos });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
