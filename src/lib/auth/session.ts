import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { cache } from "react";

import { auth, type AuthSession, type Rol } from "@/lib/auth/auth";
import {
  CODIGO_DEBE_CAMBIAR_PASSWORD,
  CODIGO_USUARIO_DESACTIVADO,
  MENSAJE_DEBE_CAMBIAR_PASSWORD,
  MENSAJE_USUARIO_DESACTIVADO,
  estaDesactivado,
  tieneClaveTemporal,
} from "@/lib/auth/estado-cuenta";
import {
  leerCookie,
  nombreCookieRolSimulado,
  resolverRolEfectivo,
  type RolSimulable,
} from "@/lib/auth/rol-simulado";
import { prisma } from "@/lib/db/prisma";

/**
 * Sesión REAL tal como la devuelve Better Auth (cookieCache de 5 min), sin
 * filtrar usuarios desactivados y con el rol que tiene el usuario en la BD.
 * Deduplicada por request con React.cache.
 *
 * Solo la usan quienes necesitan la identidad y el rol verdaderos: la ruta que
 * activa/desactiva «Probar como otro rol» y `getSimulacionActual`. Todo lo
 * demás debe pasar por `getSesionCruda`.
 */
export const getSesionReal = cache(async (): Promise<AuthSession | null> => {
  return auth.api.getSession({
    headers: await headers(),
  });
});

/**
 * Sesión con el rol EFECTIVO. Es el ÚNICO punto donde se sustituye el rol por
 * el de «Probar como otro rol» (solo la administradora, ver `rol-simulado.ts`):
 * de aquí salen `getCurrentSession`, `requireSession`/`requireRole` (las rutas
 * API), `exigirAccesoPagina`, el layout (menú y `RolProvider`) y la raíz `/`.
 * Al sustituirlo en un solo lugar, API, páginas y menú aplican el mismo rol
 * probado y no hay forma de que una capa siga viendo ADMIN.
 *
 * La identidad no cambia (`user.id`, correo…): lo que haga la administradora
 * queda a su nombre. Se devuelve una COPIA; el objeto cacheado por
 * `getSesionReal` no se muta. El valor de la cookie (`ROL.userId`) solo cuenta
 * si el rol real es ADMIN, es uno de los roles simulables y el `userId` es el
 * de esta sesión: nunca sube permisos ni pasa de una persona a otra.
 *
 * La cookie se lee de la cabecera `Cookie` (la misma que ya lee Better Auth).
 */
export const getSesionCruda = cache(async (): Promise<AuthSession | null> => {
  const session = await getSesionReal();
  if (!session) return null;

  const cabeceras = await headers();
  const valor = leerCookie(cabeceras.get("cookie"), nombreCookieRolSimulado());
  const { rol, simulado } = resolverRolEfectivo(session.user.rol, valor, session.user.id);
  if (!simulado) return session;

  return { ...session, user: { ...session.user, rol } };
});

/**
 * Rol real y rol que se está probando (si lo hay), para la franja y el
 * selector de la cabecera. Sin sesión → `null`.
 */
export const getSimulacionActual = cache(
  async (): Promise<{ rolReal: Rol; simulado: RolSimulable | null } | null> => {
    const session = await getSesionReal();
    if (!session) return null;

    const cabeceras = await headers();
    const valor = leerCookie(cabeceras.get("cookie"), nombreCookieRolSimulado());
    const { simulado } = resolverRolEfectivo(session.user.rol, valor, session.user.id);
    return { rolReal: session.user.rol as Rol, simulado };
  },
);

/**
 * Sesión actual, deduplicada por request con React.cache: el layout, el guard
 * de página y la página pueden llamarla y solo se consulta una vez.
 *
 * Un usuario desactivado cuenta como SIN sesión (el layout, la raíz y el login
 * lo tratan como anónimo y no hay bucles de redirección). Sus sesiones se
 * borran al desactivarlo; esto cubre la cookie cacheada que aún vive ≤ 5 min.
 */
export const getCurrentSession = cache(async (): Promise<AuthSession | null> => {
  const session = await getSesionCruda();
  if (!session || estaDesactivado(session.user)) return null;
  return session;
});

/**
 * ¿Debe cambiar su clave temporal antes de seguir? La cookie cacheada puede
 * decir `true` cuando ya la cambió (p. ej. desde otra pestaña): en ese caso,
 * que es raro, se confirma contra la BD para no dejarlo atascado. El caso
 * común (`false`) no toca la BD.
 */
export const debeCambiarPasswordAhora = cache(async (session: AuthSession): Promise<boolean> => {
  if (!tieneClaveTemporal(session.user)) return false;
  const usuario = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { debeCambiarPassword: true },
  });
  return usuario?.debeCambiarPassword ?? false;
});

/**
 * Sesión obligatoria para las rutas API.
 * - Sin sesión → 401.
 * - Usuario desactivado → 401 con `codigo: "USUARIO_DESACTIVADO"`.
 * - Clave temporal sin cambiar → 403 con `codigo: "DEBE_CAMBIAR_PASSWORD"`.
 *   El cambio de clave va por `/api/auth/change-password` (Better Auth), que
 *   no pasa por aquí, así que nunca queda bloqueado.
 */
export async function requireSession(): Promise<AuthSession | NextResponse> {
  const session = await getSesionCruda();

  if (!session) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

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

  return session;
}

export async function requireRole(
  allowedRoles: readonly Rol[],
): Promise<AuthSession | NextResponse> {
  const session = await requireSession();

  if (session instanceof NextResponse) {
    return session;
  }

  if (!allowedRoles.includes(session.user.rol as Rol)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  return session;
}
