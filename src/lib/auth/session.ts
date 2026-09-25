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
import { prisma } from "@/lib/db/prisma";

/**
 * Sesión tal como la devuelve Better Auth (cookieCache de 5 min), sin filtrar
 * usuarios desactivados. Deduplicada por request con React.cache.
 */
export const getSesionCruda = cache(async (): Promise<AuthSession | null> => {
  return auth.api.getSession({
    headers: await headers(),
  });
});

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
