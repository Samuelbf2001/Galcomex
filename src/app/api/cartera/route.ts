/**
 * GET /api/cartera?clienteId=...&pendientes=true  — Cartera del cliente
 * Roles: ADMIN, REVISOR
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getCarteraCliente } from "@/lib/cartera/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { carteraQuerySchema } from "@/lib/validations/borradores";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const query = carteraQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      pendientes: request.nextUrl.searchParams.get("pendientes") ?? undefined,
    });

    const cartera = await getCarteraCliente({
      clienteId: query.clienteId,
      soloPendientes: query.pendientes,
    });

    return jsonResponse({ cartera });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
