import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { estadoSolicitudPse } from "@/lib/whatsapp/pse-service";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/tramites/[id]/pse-codigo
 * Polling del operario: ¿ya llegó el código? Además cuenta cómo va el WhatsApp
 * (enviado / entregado / leído / falló) y si alguien tocó "No puedo ahora".
 * Devuelve { ready: false, ... } o { ready: true, codigo: "482913", respondidaPor, canal, ... }.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;
  return jsonResponse(await estadoSolicitudPse(id));
}
