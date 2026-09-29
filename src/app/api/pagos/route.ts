import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { listarPagosGlobal } from "@/lib/pagos/service";
import { listarPagosQuerySchema } from "@/lib/validations/pagos";

/**
 * GET /api/pagos — vista global de pagos de todos los trámites (módulo Pagos).
 *
 * Filtros (query): clienteId, tramiteId, canalPago, proveedorEmpresaId,
 * beneficiarioId (proveedor: pagos a sus fichas ∪ pagos que cubren sus
 * facturas), soloSinFecha (alias heredado `solo_pendientes` / `soloPendientes`).
 * Con proveedor devuelve también `resumenProveedor` (misma cifra que la ficha),
 * salvo a OPERATIVO, que no ve los totales del proveedor (D-6/R16).
 * La creación/edición/borrado sigue en /api/tramites/[id]/pagos y /api/pagos/multi.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const q = request.nextUrl.searchParams;
    const params = listarPagosQuerySchema.parse({
      clienteId: q.get("clienteId") ?? undefined,
      tramiteId: q.get("tramiteId") ?? undefined,
      canalPago: q.get("canalPago") ?? undefined,
      soloPendientes: q.get("solo_pendientes") ?? q.get("soloPendientes") ?? undefined,
      soloSinFecha: q.get("soloSinFecha") ?? q.get("solo_sin_fecha") ?? undefined,
      proveedorEmpresaId: q.get("proveedorEmpresaId") ?? undefined,
      beneficiarioId: q.get("beneficiarioId") ?? undefined,
    });

    const result = await listarPagosGlobal(params, { rol: session.user.rol });

    return jsonResponse(result);
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
