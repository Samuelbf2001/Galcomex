import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
} from "@/lib/facturas-proveedor/service";
import {
  MatrizCanalNoEncontradoError,
  PagoFacturaDeOtroTramiteError,
  SinAnticipoAplicadoError,
  crearPago,
  getLibroPagos,
  getPagoConBeneficiario,
} from "@/lib/pagos/service";
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

    return jsonResponse({ pago }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (error instanceof MatrizCanalNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof FacturaProveedorNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    if (error instanceof FacturaProveedorNoModificableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }

    if (error instanceof PagoFacturaDeOtroTramiteError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }

    if (error instanceof SinAnticipoAplicadoError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }

    throw error;
  }
}
