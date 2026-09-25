import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { restablecerPassword } from "@/lib/usuarios/service";
import { resetPasswordSchema } from "@/lib/validations/usuarios";

type RouteParams = { params: Promise<{ id: string }> };

/** Cuerpo opcional: vacío equivale a `{}`; JSON roto llega como `null` y Zod lo rechaza. */
async function leerCuerpoOpcional(request: NextRequest): Promise<unknown> {
  const texto = await request.text();
  if (!texto.trim()) return {};
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return null;
  }
}

/**
 * POST — restablece la contraseña. Solo ADMIN.
 * - `{}` o sin cuerpo: genera una clave temporal y la devuelve UNA vez en
 *   `passwordTemporal`.
 * - `{ nuevaPassword }` (tool MCP `usuario_reset_password`): usa esa, mínimo 10.
 * En ambos casos el usuario debe cambiarla al entrar y se cierran sus sesiones.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  try {
    const payload = resetPasswordSchema.parse(await leerCuerpoOpcional(request));
    const { passwordTemporal } = await restablecerPassword(
      id,
      session.user.id,
      payload.nuevaPassword,
    );
    return jsonResponse(passwordTemporal ? { ok: true, passwordTemporal } : { ok: true });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
