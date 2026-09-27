import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { getEstadoCuentaProveedor } from "@/lib/cxp/estado-cuenta";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/clientes/[id]/cuenta-proveedor — estado de cuenta con el proveedor
 * (`EstadoCuentaProveedorJson`): lo que Galcomex le debe, factura por factura,
 * y el registro de pagos.
 *
 * ADMIN y REVISOR: vista COMPLETA, solo lectura para el REVISOR (Guillermo lee
 * la cartera del proveedor sin poder pagar: la ficha no llama a /api/pagos/multi).
 * OPERATIVO (D-6, como hoy): SOLO_PENDIENTES, sin totales ni registro de pagos.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const estado = await getEstadoCuentaProveedor(id, session.user.rol);
    return jsonResponse(estado);
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
