import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { crearPago, getLibroPagos, getPagoConBeneficiario } from "@/lib/pagos/service";
import { crearPagoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const libro = await getLibroPagos(id);

  return jsonResponse(libro);
}

/**
 * POST /api/tramites/[id]/pagos — pago suelto del DO (CxP v2, §B.3).
 * Con `aplicaciones` (Σ montos = valor) o la entrada heredada
 * `facturaProveedorIds` (reparto FIFO). 201 con `{ pago }`; 200 con
 * `{ pago, repetido: true }` si la `claveIdempotencia` ya se registró.
 * Errores con `{ error, codigo, detalles? }` (FACTURA_SIN_SALDO 409,
 * MONTO_EXCEDE_SALDO 409, FACTURA_DE_OTRO_PROVEEDOR 422, SIN_ANTICIPO 422…).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = crearPagoSchema.parse(await request.json());

    const creado = await crearPago({
      tramiteId: id,
      ...payload,
      usuarioId: session.user.id,
    });
    const pago = await getPagoConBeneficiario(creado.id);

    return jsonResponse({ pago, repetido: creado.repetido }, { status: creado.repetido ? 200 : 201 });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
