/**
 * PATCH /api/borradores/[id]/anticipo — B8 (Diseño A): excepción ADMIN para
 * asignar a mano el anticipo de ESTA factura (repartir entre facturas del
 * mismo DO, o reemitir tras nota crédito), o volver a la regla automática.
 * Solo formato CONCEPTOS_IVA; solo BORRADOR o EN_REVISION.
 *
 * Roles: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { anticipoDelTramite } from "@/lib/borradores/anticipo-disponible";
import { asignarAnticipoBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { asignarAnticipoPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    const payload = asignarAnticipoPayloadSchema.parse(body);
    const result = await asignarAnticipoBorrador(borradorId, payload, session.user.id);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, ...(result.codigo ? { codigo: result.codigo } : {}) },
        { status: result.status },
      );
    }

    // M1 (revisión de código, 28-sep-2026): devolver `anticipoDo` como el GET,
    // así el desglose y "asignado a mano" se ven sin recargar tras guardar.
    const anticipoDo = result.borrador
      ? await anticipoDelTramite(prisma, result.borrador.tramiteId, { excluirBorradorId: borradorId })
      : null;

    return jsonResponse({
      borrador: result.borrador ? { ...result.borrador, anticipoDo } : result.borrador,
      ...(result.aviso ? { aviso: result.aviso } : {}),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }
    throw error;
  }
}
