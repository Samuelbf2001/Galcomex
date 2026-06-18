import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  FacturaProveedorConPagosError,
  FacturaProveedorDuplicadaError,
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
  actualizarFacturaProveedor,
  eliminarFacturaProveedor,
} from "@/lib/facturas-proveedor/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarFacturaProveedorSchema } from "@/lib/validations/facturas-proveedor";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = actualizarFacturaProveedorSchema.parse(await request.json());

    const factura = await actualizarFacturaProveedor(id, payload, session.user.id);
    return jsonResponse({ factura });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (error instanceof FacturaProveedorNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof FacturaProveedorDuplicadaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof FacturaProveedorNoModificableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    await eliminarFacturaProveedor(id, session.user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof FacturaProveedorNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof FacturaProveedorConPagosError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
