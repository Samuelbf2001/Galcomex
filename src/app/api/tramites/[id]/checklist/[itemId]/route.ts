import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarItemChecklist } from "@/lib/tramites/checklist";
import { checklistUpdateSchema } from "@/lib/validations/tramites";

type RouteContext = {
  params: Promise<{
    id: string;
    itemId: string;
  }>;
};

/**
 * Marca o desmarca un ítem del checklist. ADMIN, REVISOR y OPERATIVO; el ítem
 * "CUADRE DE PLATA HISTÓRICA" de un DO histórico solo ADMIN y REVISOR (403).
 * DO CERRADO → 409. Deja AuditLog `UPDATE_CHECKLIST_ITEM` (ver lib/tramites/checklist.ts).
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id, itemId } = await context.params;
    const payload = checklistUpdateSchema.parse(await request.json());

    const item = await actualizarItemChecklist({
      tramiteId: id,
      itemId,
      recibido: payload.recibido,
      usuarioId: session.user.id,
      rol: session.user.rol,
    });

    return jsonResponse({ item });
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
