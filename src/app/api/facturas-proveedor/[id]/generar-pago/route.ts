import { TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
  generarPagoDesdeFactura,
} from "@/lib/facturas-proveedor/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";
import { generarPagoDesdeFacturaSchema } from "@/lib/validations/facturas-proveedor";

type RouteContext = {
  params: Promise<{ id: string }>;
};

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

    return jsonResponse(resultado, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (error instanceof FacturaProveedorNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof FacturaProveedorNoModificableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
