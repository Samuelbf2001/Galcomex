import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { listarCatalogoEventos } from "@/lib/eventos/service";
import { jsonResponse } from "@/lib/http/json";

/** GET — catálogo de eventos facturables activos (M3). Todos los roles. */
export async function GET() {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);
  if (session instanceof NextResponse) return session;

  return jsonResponse({ eventos: await listarCatalogoEventos() });
}
