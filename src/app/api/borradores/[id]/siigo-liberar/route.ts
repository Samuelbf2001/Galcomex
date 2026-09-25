/**
 * POST /api/borradores/[id]/siigo-liberar — «Liberar para reenviar».
 *
 * Un envío INCIERTO sin id de SIIGO pasa a ERROR (se puede volver a enviar)
 * después de que el ADMIN revisó el portal de SIIGO y la factura no está.
 * Exige `{ "confirmo": true }` (la UI lo manda tras un diálogo de
 * confirmación) y deja AuditLog SIIGO_ENVIO_LIBERADO.
 *
 * Rol: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { liberarEnvioSiigo } from "@/lib/siigo/resolver-envio-service";
import { liberarEnvioSiigoPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    liberarEnvioSiigoPayloadSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    const resultado = await liberarEnvioSiigo(borradorId, session.user.id);
    return jsonResponse(resultado);
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
