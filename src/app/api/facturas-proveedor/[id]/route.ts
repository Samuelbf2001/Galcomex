import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { CxpError, cuerpoErrorCxp } from "@/lib/cxp/errores";
import {
  FacturaProveedorConPagosError,
  FacturaProveedorDuplicadaError,
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
  actualizarFacturaProveedor,
  eliminarFacturaProveedor,
} from "@/lib/facturas-proveedor/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarFacturaProveedorSchema } from "@/lib/validations/facturas-proveedor";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** Errores de dominio → `{ error, codigo?, detalles? }` con su status; null si no es de dominio. */
function respuestaError(error: unknown): NextResponse | null {
  if (error instanceof ZodError) {
    return validationError(error);
  }
  if (error instanceof CxpError) {
    return jsonResponse(cuerpoErrorCxp(error), { status: error.status });
  }
  if (error instanceof FacturaProveedorNoEncontradaError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof FacturaProveedorDuplicadaError) {
    return NextResponse.json({ error: error.message, codigo: "FACTURA_DUPLICADA" }, { status: 409 });
  }
  if (isDomainError(error)) {
    const codigo = (error as { codigo?: unknown }).codigo;
    return typeof codigo === "string"
      ? NextResponse.json({ error: error.message, codigo }, { status: error.status })
      : domainErrorResponse(error);
  }
  return null;
}

/**
 * Edición (R11 sobre cambios reales). 409 `FACTURA_CON_PAGOS`,
 * 409 `FACTURA_YA_COBRADA`, 409 `FACTURA_DUPLICADA`, 409 `POSIBLE_DUPLICADO`,
 * 409 `USD_VALOR_LEJOS_DE_TRM`, 422 `PROVEEDOR_OBLIGATORIO`.
 */
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
    if (error instanceof FacturaProveedorNoModificableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    const respuesta = respuestaError(error);
    if (respuesta) return respuesta;
    throw error;
  }
}

/** Borrado: solo sin pagos, ajustes, cruce ni línea en ningún borrador (R11). */
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
    if (error instanceof FacturaProveedorConPagosError) {
      const codigo = (error as { codigo?: unknown }).codigo;
      return NextResponse.json(
        { error: error.message, codigo: typeof codigo === "string" ? codigo : "FACTURA_CON_PAGOS" },
        { status: 422 },
      );
    }
    const respuesta = respuestaError(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
