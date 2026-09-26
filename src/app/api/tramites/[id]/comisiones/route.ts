import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { comisionesDeTramite, registrarComisionTramite } from "@/lib/comisiones/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { comisionTramiteSchema } from "@/lib/validations/comisiones";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Comisión por contenedor del DO (caso LTRANS: de 4 contenedores, 2 de LTRANS
 * llevan comisión).
 *
 * GET — ADMIN, REVISOR, OPERATIVO: si aplica, empresas que pagan comisión (con
 *       su valor por contenedor), contenedores disponibles y lo registrado.
 * PUT — ADMIN, REVISOR, OPERATIVO (los mismos que editan el DO):
 *       `{ empresaId, unidades }`; `unidades = 0` la quita.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    return jsonResponse(await comisionesDeTramite(id));
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = comisionTramiteSchema.parse(await request.json());
    await registrarComisionTramite({ tramiteId: id, ...payload, usuarioId: session.user.id });

    return jsonResponse(await comisionesDeTramite(id));
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
