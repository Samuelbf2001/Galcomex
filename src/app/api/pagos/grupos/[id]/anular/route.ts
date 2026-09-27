import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { getPagoRealizadoDeGrupo } from "@/lib/cxp/estado-cuenta";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { anularPagoGrupo } from "@/lib/pagos/service";
import { anularPagoGrupoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/pagos/grupos/[id]/anular — anula el pago en bloque COMPLETO (solo
 * ADMIN, con motivo de al menos 10 caracteres). Devuelve el saldo a todas sus
 * facturas y a los DOs. 409 BLOQUE_CON_DO_CERRADO si algún DO está cerrado.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const { motivo } = anularPagoGrupoSchema.parse(await request.json());
    const resultado = await anularPagoGrupo(id, motivo, session.user.id);
    const grupo = await getPagoRealizadoDeGrupo(prisma, id);
    return jsonResponse({ ...resultado, grupo });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
