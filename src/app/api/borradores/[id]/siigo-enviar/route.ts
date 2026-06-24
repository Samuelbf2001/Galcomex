/**
 * POST /api/borradores/[id]/siigo-enviar
 *
 * Envía un borrador APROBADO a la API de SIIGO como BORRADOR (stamp.send=false).
 * La factura queda en SIIGO esperando que un usuario superior la valide y la
 * estampe manualmente desde el portal. El borrador en Galcomex se mantiene en
 * estado APROBADO y se registra siigoDraftId + enviadoASiigoEn. Cuando llegue
 * el consecutivo definitivo, el ADMIN lo marca como FACTURADO con el flujo
 * manual existente.
 *
 * Si SIIGO rechaza o no responde, el borrador permanece en APROBADO con
 * ultimoErrorSiigo poblado para que el ADMIN pueda corregir y reintentar.
 *
 * Roles: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { enviarBorradorASiigo } from "@/lib/siigo/envio-factura-service";

type RouteParams = { params: Promise<{ id: string }> };

const STATUS_POR_TIPO = {
  estado: 409,
  validacion: 422,
  config: 503,
  api: 502,
  db: 500,
} as const;

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  const result = await enviarBorradorASiigo(borradorId, session.user.id);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, tipo: result.tipo },
      { status: STATUS_POR_TIPO[result.tipo] },
    );
  }

  return jsonResponse({
    siigoDraftId: result.siigoDraftId,
    enviadoEn: result.enviadoEn,
  });
}
