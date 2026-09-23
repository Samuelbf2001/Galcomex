import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { PLANTILLAS_TARIFARIO } from "@/lib/tarifas/plantillas";

/**
 * GET — plantillas de tarifario (las propuestas 2026 transcritas). Sirven para
 * arrancar el tarifario de una empresa con `POST /api/clientes/[id]/tarifarios
 * { plantilla }`. ADMIN, REVISOR, OPERATIVO.
 */
export async function GET() {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  return jsonResponse({
    plantillas: PLANTILLAS_TARIFARIO.map((p) => ({
      codigo: p.codigo,
      cliente: p.cliente,
      nombre: p.nombre,
      descripcion: p.descripcion,
      alcance: p.alcance,
      fuente: p.fuente,
      items: p.items,
    })),
  });
}
