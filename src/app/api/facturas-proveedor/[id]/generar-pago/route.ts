import { TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";
import { generarPagoDesdeFactura } from "@/lib/pagos/generar-desde-factura";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { generarPagoDesdeFacturaSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/facturas-proveedor/[id]/generar-pago — "Generar pago" (API + MCP).
 * CxP v2: paga el saldo (o `monto`, abono) por las mismas reglas del pago
 * suelto (anticipo, proveedor, saldo, idempotencia). Una factura pagada: 409
 * FACTURA_SIN_SALDO.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;

    // SOCIO solo puede generar pagos en facturas de trámites SOCIO_LM
    if (session.user.rol === "SOCIO") {
      const factura = await prisma.facturaProveedor.findUnique({
        where: { id },
        select: { tramite: { select: { cliente: { select: { tipo: true } } } } },
      });

      if (!factura) {
        return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
      }

      if (factura.tramite.cliente.tipo !== TipoCliente.SOCIO_LM) {
        return NextResponse.json({ error: "No autorizado" }, { status: 403 });
      }
    }

    const payload = generarPagoDesdeFacturaSchema.parse(await request.json());

    const resultado = await generarPagoDesdeFactura({
      facturaProveedorId: id,
      ...payload,
      usuarioId: session.user.id,
    });

    return jsonResponse(resultado, { status: resultado.pago.repetido ? 200 : 201 });
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
