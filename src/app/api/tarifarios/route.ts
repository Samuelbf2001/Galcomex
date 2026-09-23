import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { listarTarifariosLigero } from "@/lib/tarifas/service";
import { tarifariosListQuerySchema } from "@/lib/validations/tarifas";

/**
 * GET — catálogo LIGERO de los tarifarios de TODAS las empresas (id, empresa,
 * nombre, alcance, versión, estado, cantidad de ítems; sin los ítems
 * completos), ordenado por empresa, alcance y versión descendente. Alimenta
 * "Copiar la tarifa de otra empresa" en Nuevo tarifario (B2, 22-sep).
 *
 * ADMIN (mismo rol que crea tarifarios). Query opcional `excluirEmpresaId`
 * para no mostrarle a una empresa su propio tarifario como "otra empresa".
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const query = tarifariosListQuerySchema.parse({
      excluirEmpresaId: request.nextUrl.searchParams.get("excluirEmpresaId") ?? undefined,
    });
    const tarifarios = await listarTarifariosLigero(query);

    return jsonResponse({ tarifarios });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
