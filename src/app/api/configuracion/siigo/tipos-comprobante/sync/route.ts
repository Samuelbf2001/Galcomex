import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { sincronizarTiposComprobanteSiigo } from "@/lib/siigo/sync-tipos-comprobante-service";

export async function POST(_request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const result = await sincronizarTiposComprobanteSiigo(session.user.id);

  if (!result.ok) {
    const status = result.tipo === "config" ? 503 : result.tipo === "api" ? 502 : 500;
    return NextResponse.json({ error: result.error, tipo: result.tipo }, { status });
  }

  return jsonResponse({ total: result.total });
}
