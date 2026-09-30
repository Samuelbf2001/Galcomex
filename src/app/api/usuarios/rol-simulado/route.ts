import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import {
  DURACION_SIMULACION_SEG,
  leerCookie,
  nombreCookieRolSimulado,
  opcionesCookieRolSimulado,
  resolverRolEfectivo,
  valorCookieRolSimulado,
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
 * La simulación es una cookie httpOnly (`galcomex_rol_simulado`, o
 * `__Host-galcomex_rol_simulado` en producción; ver `nombreCookieRolSimulado`)
 * con valor `ROL.userId`, que `getSesionCruda` (session.ts) aplica a toda la
 * plataforma. Solo puede BAJAR permisos (los roles simulables no incluyen
 * ADMIN), va atada a la persona que la activó y la identidad no cambia: lo que
 * haga queda a nombre de la administradora. No cambia la BD de usuarios.
 *
 * La cookie previa se lee con el mismo `leerCookie` que usa `session.ts`
 * (cabecera `Cookie`, primera ocurrencia), no con `request.cookies`, para que
 * el rol que se aplica y el que se audita sean siempre el mismo.
 */

/** ¿La petición declara cuerpo JSON? (tolera `; charset=utf-8`). */
function esJson(request: NextRequest): boolean {
  const tipo = request.headers.get("content-type") ?? "";
  return tipo.split(";")[0].trim().toLowerCase() === "application/json";
}

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

  // Solo JSON: un formulario enviado desde otro sitio (text/plain,
  // form-urlencoded) no puede activar la simulación.
  if (!esJson(request)) {
    return NextResponse.json({ error: "La solicitud debe enviarse como JSON." }, { status: 415 });
  }

  try {
    const { rol } = probarRolSchema.parse(await request.json().catch(() => null));

    // Simulación que ya estaba activa (válida para esta persona), si la hay.
    const { simulado: previo } = resolverRolEfectivo(
      session.user.rol,
      leerCookie(request.headers.get("cookie"), nombreCookieRolSimulado()),
      session.user.id,
    );
    const hasta = new Date(Date.now() + DURACION_SIMULACION_SEG * 1000).toISOString();

    await prisma.auditLog.create({
      data: {
        entidad: "User",
        entidadId: session.user.id,
        accion: "PROBAR_ROL_INICIO",
        usuarioId: session.user.id,
        ...(previo ? { antes: { rol: previo } } : {}),
        despues: { rol, hasta },
      },
    });

    const respuesta = jsonResponse({ ok: true, rol });
    respuesta.cookies.set(nombreCookieRolSimulado(), valorCookieRolSimulado(rol, session.user.id), {
      ...opcionesCookieRolSimulado(),
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
 * sesión, y sin sesión también borra la cookie: se llama al cerrar sesión y
 * NUNCA debe fallar. Si leer la sesión o escribir la auditoría da error, se
 * registra en el log y la cookie se borra igual (que «Volver» quede colgado
 * dejaría a la persona dentro de un rol que ya no quiere).
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSesionReal();

    if (session && session.user.rol === "ADMIN") {
      const { simulado: previo } = resolverRolEfectivo(
        session.user.rol,
        leerCookie(request.headers.get("cookie"), nombreCookieRolSimulado()),
        session.user.id,
      );

      if (previo) {
        await prisma.auditLog.create({
          data: {
            entidad: "User",
            entidadId: session.user.id,
            accion: "PROBAR_ROL_FIN",
            usuarioId: session.user.id,
            antes: { rol: previo },
          },
        });
      }
    }
  } catch (error) {
    console.error(
      "[rol-simulado] no se pudo auditar el fin de la prueba de rol",
      error instanceof Error ? error.message : "",
    );
  }

  const respuesta = jsonResponse({ ok: true });
  respuesta.cookies.set(nombreCookieRolSimulado(), "", {
    ...opcionesCookieRolSimulado(),
    maxAge: 0,
  });
  return respuesta;
}
