import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  actualizarEventoCatalogo,
  listarCatalogoEventosAdmin,
} from "@/lib/eventos/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { eventoCatalogoActualizarSchema } from "@/lib/validations/catalogos";

/** GET — catálogo completo de eventos, incluidos los inactivos. */
export async function GET(_request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const eventos = await listarCatalogoEventosAdmin();
  return jsonResponse({ eventos, total: eventos.length });
}

/**
 * PATCH — edita un evento (`{ codigo, ...campos }`). Solo ADMIN.
 * El `codigo` identifica y NO se puede cambiar: es la FK de `tarifa_item` y
 * `tramite_evento`.
 */
export async function PATCH(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const payload = eventoCatalogoActualizarSchema.parse(await request.json());
    const evento = await actualizarEventoCatalogo({
      ...payload,
      usuarioId: session.user.id,
    });
    return jsonResponse({ evento });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
