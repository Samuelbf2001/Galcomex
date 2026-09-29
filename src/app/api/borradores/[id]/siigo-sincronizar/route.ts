/**
 * POST /api/borradores/[id]/siigo-sincronizar
 *
 * Consulta Siigo por el siigoDraftId del borrador y, si ya tiene consecutivo
 * definitivo asignado por un superior en el portal, marca el borrador como
 * FACTURADO + crea registro Factura (cartera).
 *
 * Fase centavos (D-7): si el total que liquidó Siigo no es igual al centavo al
 * del borrador responde 409 con `codigo: "SIIGO_TOTAL_DISTINTO"` y los dos
 * valores (`totalSiigo`, `totalBorrador` en pesos texto "1487623.45"); no se
 * crea la Factura.
 *
 * Idempotente: si el borrador ya está FACTURADO, devuelve los datos actuales.
 *
 * Rol: ADMIN.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { sincronizarFacturaDesdeSiigo } from "@/lib/siigo/sincronizar-factura-service";

type RouteParams = { params: Promise<{ id: string }> };

const STATUS_POR_TIPO = {
  estado: 409,
  config: 503,
  api: 502,
  db: 500,
  total_distinto: 409,
} as const;

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  const result = await sincronizarFacturaDesdeSiigo(borradorId, session.user.id);

  if (!result.ok) {
    if (result.tipo === "total_distinto") {
      // bigint (centavos) → el serializador único los emite como pesos texto.
      return jsonResponse(
        {
          error: result.error,
          tipo: result.tipo,
          codigo: result.codigo,
          numFacturaSiigo: result.numFacturaSiigo,
          totalSiigo: result.totalSiigoCentavos,
          totalBorrador: result.totalBorradorCentavos,
          diferencias: result.diferencias.map((d) => ({
            campo: d.campo,
            siigo: d.siigoCentavos,
            borrador: d.borradorCentavos,
          })),
        },
        { status: STATUS_POR_TIPO.total_distinto },
      );
    }
    return NextResponse.json(
      { error: result.error, tipo: result.tipo },
      { status: STATUS_POR_TIPO[result.tipo] },
    );
  }

  return jsonResponse({
    facturada: result.facturada,
    numFacturaSiigo: result.numFacturaSiigo,
    fechaFactura: result.fechaFactura,
    stampStatus: result.stampStatus,
    mensaje: result.mensaje,
  });
}
