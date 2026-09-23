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
 * Cuerpo opcional `{ reenviar: true, siigoDraftIdAnterior }`: sin él, un
 * borrador que ya tiene siigoDraftId se rechaza (409) para no duplicar la
 * factura en Siigo. Envíos simultáneos del mismo borrador → 409 "en curso".
 *
 * Roles: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { enviarBorradorASiigo } from "@/lib/siigo/envio-factura-service";
import { enviarSiigoPayloadSchema, type EnviarSiigoPayload } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

const STATUS_POR_TIPO = {
  estado: 409,
  validacion: 422,
  config: 503,
  api: 502,
  db: 500,
} as const;

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  // El cuerpo es opcional (primer envío): vacío equivale a `{}`.
  let body: unknown = {};
  try {
    const texto = await request.text();
    if (texto.trim()) body = JSON.parse(texto);
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let payload: EnviarSiigoPayload;
  try {
    payload = enviarSiigoPayloadSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const result = await enviarBorradorASiigo(borradorId, session.user.id, {
    reenviar: payload.reenviar ?? false,
    siigoDraftIdAnterior: payload.siigoDraftIdAnterior ?? null,
  });

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
