import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  restablecerPassword,
  UsuarioNoEncontradoError,
} from "@/lib/usuarios/service";
import { resetPasswordSchema } from "@/lib/validations/usuarios";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  let payload: ReturnType<typeof resetPasswordSchema.parse>;
  try {
    payload = resetPasswordSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    await restablecerPassword(id, payload.nuevaPassword, session.user.id);
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof UsuarioNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
