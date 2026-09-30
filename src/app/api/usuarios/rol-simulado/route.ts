import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import {
  COOKIE_ROL_SIMULADO,
  DURACION_SIMULACION_SEG,
  esRolSimulable,
} from "@/lib/auth/rol-simulado";
import { debeCambiarPasswordAhora, getSesionReal } from "@/lib/auth/session";
import {
  CODIGO_DEBE_CAMBIAR_PASSWORD,
  CODIGO_USUARIO_DESACTIVADO,
  MENSAJE_DEBE_CAMBIAR_PASSWORD,
  MENSAJE_USUARIO_DESACTIVADO,
  estaDesactivado,
} from "@/lib/auth/estado-cuenta";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { probarRolSchema } from "@/lib/validations/usuarios";

/**
 * «Probar como otro rol» — solo la administradora.
 *
 * Esta ruta autoriza con la sesión REAL (`getSesionReal`), no con la efectiva:
 * si ya está probando otro rol, sigue pudiendo cambiarlo o volver.
 *
 * La simulación es una cookie httpOnly (`galcomex_rol_simulado`) que
 * `getSesionCruda` (session.ts) aplica a toda la plataforma. Solo puede BAJAR
 * permisos (los roles simulables no incluyen ADMIN) y la identidad no cambia:
 * lo que haga queda a nombre de la administradora. No cambia la BD de usuarios.
 */

/** Atributos de la cookie: solo el servidor la lee y no viaja a otros sitios. */
const OPCIONES_COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/** POST `{ rol }` — empieza a probar la plataforma como ese rol. Solo ADMIN (rol real). */
export async function POST(request: NextRequest) {
  const session = await getSesionReal();

  if (!session) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  // Mismas puertas que `requireSession`, pero con la sesión real.
  if (estaDesactivado(session.user)) {
    return NextResponse.json(
      { error: MENSAJE_USUARIO_DESACTIVADO, codigo: CODIGO_USUARIO_DESACTIVADO },
      { status: 401 },
    );
  }

  if (await debeCambiarPasswordAhora(session)) {
    return NextResponse.json(
      { error: MENSAJE_DEBE_CAMBIAR_PASSWORD, codigo: CODIGO_DEBE_CAMBIAR_PASSWORD },
      { status: 403 },
    );
  }

  if (session.user.rol !== "ADMIN") {
    return NextResponse.json(
      { error: "Solo la administradora puede probar otros roles" },
      { status: 403 },
    );
  }

  try {
    const { rol } = probarRolSchema.parse(await request.json().catch(() => null));

    await prisma.auditLog.create({
      data: {
        entidad: "User",
        entidadId: session.user.id,
        accion: "PROBAR_ROL_INICIO",
        usuarioId: session.user.id,
        despues: { rol },
      },
    });

    const respuesta = jsonResponse({ ok: true, rol });
    respuesta.cookies.set(COOKIE_ROL_SIMULADO, rol, {
      ...OPCIONES_COOKIE,
      maxAge: DURACION_SIMULACION_SEG,
    });
    return respuesta;
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }
}

/**
 * DELETE — vuelve a ser administradora (borra la cookie). Vale para cualquier
 * sesión, y sin sesión también borra la cookie: se llama al cerrar sesión y no
 * debe fallar aunque la sesión ya haya caducado.
 */
export async function DELETE(request: NextRequest) {
  const session = await getSesionReal();
  const valorCookie = request.cookies.get(COOKIE_ROL_SIMULADO)?.value;

  if (session && session.user.rol === "ADMIN" && esRolSimulable(valorCookie)) {
    await prisma.auditLog.create({
      data: {
        entidad: "User",
        entidadId: session.user.id,
        accion: "PROBAR_ROL_FIN",
        usuarioId: session.user.id,
        antes: { rol: valorCookie },
      },
    });
  }

  const respuesta = jsonResponse({ ok: true });
  respuesta.cookies.set(COOKIE_ROL_SIMULADO, "", { ...OPCIONES_COOKIE, maxAge: 0 });
  return respuesta;
}
