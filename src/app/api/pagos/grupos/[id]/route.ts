import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { getPagoRealizadoDeGrupo } from "@/lib/cxp/estado-cuenta";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { actualizarPagoGrupo } from "@/lib/pagos/service";
import { actualizarPagoGrupoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/pagos/grupos/[id] — detalle de un pago en bloque (la transferencia):
 * DOs, facturas con monto, costo y quién lo asume, comprobante, anulación.
 * Formato `PagoRealizadoJson`. Todos los roles menos SOCIO.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;
  const grupo = await getPagoRealizadoDeGrupo(prisma, id);
  if (!grupo) {
    return NextResponse.json({ error: "Pago en bloque no encontrado" }, { status: 404 });
  }
  return jsonResponse({ grupo });
}

/**
 * PATCH /api/pagos/grupos/[id] — concepto, fecha, comprobantes y valor que
 * salió del banco; se propaga a todos los pagos del bloque. ADMIN/OPERATIVO.
 * El valor y el canal no se editan: se anula el bloque y se registra de nuevo.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const payload = actualizarPagoGrupoSchema.parse(await request.json());
    const { advertencias } = await actualizarPagoGrupo(id, payload, session.user.id);
    const grupo = await getPagoRealizadoDeGrupo(prisma, id);
    return jsonResponse({ grupo, advertencias });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
