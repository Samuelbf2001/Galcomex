import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { crearUsuario, listarUsuarios } from "@/lib/usuarios/service";
import { crearUsuarioSchema } from "@/lib/validations/usuarios";

/** GET — lista de usuarios con su estado. Solo ADMIN. */
export async function GET() {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const usuarios = await listarUsuarios();
  return jsonResponse({ usuarios, total: usuarios.length });
}

/**
 * POST — crea un usuario (`{ name, email, rol }`). Solo ADMIN. Responde la
 * clave temporal UNA sola vez: no queda guardada en claro en ninguna parte.
 */
export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const payload = crearUsuarioSchema.parse(await request.json().catch(() => null));
    const { usuario, passwordTemporal } = await crearUsuario(payload, session.user.id);
    return jsonResponse({ usuario, passwordTemporal }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
