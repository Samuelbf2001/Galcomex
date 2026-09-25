import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarUsuario } from "@/lib/usuarios/service";
import { actualizarUsuarioSchema } from "@/lib/validations/usuarios";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * PATCH — cambia nombre, rol y/o estado (`{ name?, rol?, activo? }`). Solo
 * ADMIN. Reglas: nadie se desactiva ni se quita el rol ADMIN a sí mismo, y
 * siempre queda al menos un ADMIN activo (422). Desactivar cierra sus sesiones.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  try {
    const payload = actualizarUsuarioSchema.parse(await request.json().catch(() => null));
    const usuario = await actualizarUsuario(id, payload, session.user.id);
    return jsonResponse({ usuario });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
