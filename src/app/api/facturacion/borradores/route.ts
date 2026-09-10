/**
 * GET /api/facturacion/borradores?tramiteIds=id1,id2,...
 *
 * Carga por lote de los borradores de hasta 100 trámites. Elimina el N+1 de
 * la pantalla de facturación, que antes pedía GET /api/tramites/[id]/borrador
 * por cada trámite de la lista.
 *
 * Para cada id aplica EXACTAMENTE la lógica del endpoint individual
 * (permiso/scope del trámite, ensureBorrador, listarBorradores) vía
 * `cargarBorradoresDeTramite`. Los trámites que fallan (no encontrado, sin
 * permiso, error) llevan `{ error }` y no bloquean al resto. Se resuelven en
 * grupos de 10 con Promise.all.
 *
 * Roles: los mismos que el GET individual (ADMIN, REVISOR, SOCIO).
 *
 * Respuesta:
 *   { porTramite: { [tramiteId]: { borradores: [...] } | { error: "..." } } }
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  ROLES_CONSULTA_BORRADORES,
  cargarBorradoresEnLote,
} from "@/lib/borradores/consulta";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { borradoresLoteQuerySchema } from "@/lib/validations/borradores";

export async function GET(request: NextRequest) {
  const session = await requireRole(ROLES_CONSULTA_BORRADORES);

  if (session instanceof NextResponse) {
    return session;
  }

  let query: ReturnType<typeof borradoresLoteQuerySchema.parse>;
  try {
    query = borradoresLoteQuerySchema.parse({
      tramiteIds: request.nextUrl.searchParams.get("tramiteIds") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  const porTramite = await cargarBorradoresEnLote(query.tramiteIds, session.user);

  return jsonResponse({ porTramite });
}
