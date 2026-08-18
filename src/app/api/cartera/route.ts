/**
 * GET /api/cartera?clienteId=...&pendientes=true&take=50&skip=0  — Cartera del cliente
 * Roles: ADMIN, REVISOR
 *
 * D2-b: paginación server-side de las FILAS (take/skip, default take=50).
 * Los agregados (cruceCliente, cruceLM, totalFacturas) los calcula
 * getCarteraCliente siempre sobre el conjunto COMPLETO que cumple los
 * filtros de cliente/fecha/pendientes — nunca sobre la página visible — para
 * que el saldo mostrado no mienta cuando hay más de una página.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getCarteraCliente } from "@/lib/cartera/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { carteraQuerySchema } from "@/lib/validations/borradores";

/** Default de página para el listado interactivo (no aplica al export/PDF, que llaman a getCarteraCliente sin take/skip para traer el histórico completo). */
const DEFAULT_TAKE = 50;

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const query = carteraQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      pendientes: request.nextUrl.searchParams.get("pendientes") ?? undefined,
      desde: request.nextUrl.searchParams.get("desde") ?? undefined,
      hasta: request.nextUrl.searchParams.get("hasta") ?? undefined,
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });

    const cartera = await getCarteraCliente({
      clienteId: query.clienteId,
      soloPendientes: query.pendientes,
      desde: query.desde,
      hasta: query.hasta,
      take: query.take ?? DEFAULT_TAKE,
      skip: query.skip ?? 0,
    });

    return jsonResponse({ cartera });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
