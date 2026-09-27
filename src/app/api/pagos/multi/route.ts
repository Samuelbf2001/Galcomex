import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { aFacturaElegibleJson } from "@/lib/cxp/estado-cuenta";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { costosBancariosPorCanal, crearPagoMultiDO, listarFacturasElegiblesMultiDO } from "@/lib/pagos/service";
import {
  crearPagoMultiDOSchema,
  listarFacturasElegiblesMultiDOQuerySchema,
} from "@/lib/validations/pagos";

/**
 * GET /api/pagos/multi?beneficiarioId=xxx | ?empresaId=yyy
 *   Facturas con saldo (Pendientes y Abonadas) del proveedor, de TODOS los
 *   DOs, con su pagabilidad (`FacturaElegibleJson`) — selector del modal
 *   "Pagar en bloque". ADMIN/OPERATIVO (la ficha del REVISOR usa
 *   /api/clientes/[id]/cuenta-proveedor, no esta ruta). Trae también
 *   `costosPorCanal` (matriz de pago) para mostrar el costo de la
 *   transferencia antes de confirmar.
 *
 * POST /api/pagos/multi
 *   Crea el pago en bloque (CxP v2, §B.3): una transferencia y un comprobante
 *   para varias facturas de varios DOs. 201 con `{ grupoPagoId, pagos,
 *   advertencias, repetido: false }`; 200 con `repetido: true` si la misma
 *   `claveIdempotencia` ya se registró (doble clic). Registro histórico
 *   (`esHistorico`) solo ADMIN.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const filtro = listarFacturasElegiblesMultiDOQuerySchema.parse({
      beneficiarioId: request.nextUrl.searchParams.get("beneficiarioId") ?? undefined,
      empresaId: request.nextUrl.searchParams.get("empresaId") ?? undefined,
    });

    const [facturas, costosPorCanal] = await Promise.all([
      listarFacturasElegiblesMultiDO(filtro),
      costosBancariosPorCanal(),
    ]);

    return jsonResponse({ facturas: facturas.map(aFacturaElegibleJson), costosPorCanal });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = crearPagoMultiDOSchema.parse(await request.json());

    if (payload.esHistorico && session.user.rol !== "ADMIN") {
      return NextResponse.json(
        { error: "Solo un administrador puede registrar pagos históricos de conciliación." },
        { status: 403 },
      );
    }

    const resultado = await crearPagoMultiDO({
      ...payload,
      usuarioId: session.user.id,
    });

    return jsonResponse(resultado, { status: resultado.repetido ? 200 : 201 });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
