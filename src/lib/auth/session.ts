import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth, type AuthSession, type Rol } from "@/lib/auth/auth";

export async function getCurrentSession(): Promise<AuthSession | null> {
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requireSession(): Promise<AuthSession | NextResponse> {
  const session = await getCurrentSession();

  if (!session) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
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
