import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { listarPagosGlobal } from "@/lib/pagos/service";
import { listarPagosQuerySchema } from "@/lib/validations/pagos";

/**
 * GET /api/pagos — vista global de pagos de todos los trámites.
 * La creación/edición/borrado sigue ocurriendo en /api/tramites/[id]/pagos,
 * que ya resuelve costoBancario, orden y AuditLog.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const params = listarPagosQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      tramiteId: request.nextUrl.searchParams.get("tramiteId") ?? undefined,
      canalPago: request.nextUrl.searchParams.get("canalPago") ?? undefined,
      soloPendientes:
        request.nextUrl.searchParams.get("solo_pendientes") ?? undefined,
    });

    const result = await listarPagosGlobal(params);

    return jsonResponse(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
