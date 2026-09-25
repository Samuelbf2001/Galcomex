/**
 * POST /api/borradores/[id]/siigo-enviar
 *
 * Envía un borrador APROBADO a la API de SIIGO como BORRADOR (stamp.send=false).
 * La factura queda en SIIGO esperando que un usuario superior la valide y la
 * estampe manualmente desde el portal. El borrador en Galcomex se mantiene en
 * estado APROBADO y se registra siigoDraftId + enviadoASiigoEn.
 *
 * Una factura, un solo POST (ver `envio-factura-service.ts`):
 * - 409 si ya se envió, hay un envío en curso o el último quedó INCIERTO
 *   ("Esta factura ya se envió o se está enviando a SIIGO").
 * - Rechazo de SIIGO (4xx de validación) → `siigoEnvioEstado: ERROR`, se puede
 *   reintentar.
 * - Timeout, red, 5xx o respuesta inválida → `siigoEnvioEstado: INCIERTO`
 *   (`tipo: "incierto"`, 502): no se puede reintentar hasta que un ADMIN use
 *   «Revisar en SIIGO».
 *
 * Cuerpo: vacío o `{}`. El antiguo reenvío (`reenviar`) ya no existe → 400.
 *
 * Roles: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { enviarBorradorASiigo } from "@/lib/siigo/envio-factura-service";
import { EnvioSiigoBloqueadoError } from "@/lib/siigo/errores-envio";
import { enviarSiigoPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

const STATUS_POR_TIPO = {
  estado: 409,
  validacion: 422,
  config: 503,
  api: 502,
  incierto: 502,
  db: 500,
} as const;

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  // El cuerpo es opcional: vacío equivale a `{}`.
  let body: unknown = {};
  try {
    const texto = await request.text();
    if (texto.trim()) body = JSON.parse(texto);
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    enviarSiigoPayloadSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    const result = await enviarBorradorASiigo(borradorId, session.user.id);

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          tipo: result.tipo,
          siigoEnvioEstado: result.siigoEnvioEstado ?? null,
          siigoDraftId: result.siigoDraftId ?? null,
        },
        { status: STATUS_POR_TIPO[result.tipo] },
      );
    }

    return jsonResponse({
      siigoDraftId: result.siigoDraftId,
      enviadoEn: result.enviadoEn,
      siigoEnvioEstado: result.siigoEnvioEstado,
    });
  } catch (error) {
    if (error instanceof EnvioSiigoBloqueadoError) {
      return NextResponse.json(
        { error: error.message, tipo: "estado", codigo: error.codigo },
        { status: error.status },
      );
    }
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
