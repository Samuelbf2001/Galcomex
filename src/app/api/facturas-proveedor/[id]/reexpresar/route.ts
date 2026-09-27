import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { CxpError, cuerpoErrorCxp } from "@/lib/cxp/errores";
import {
  FacturaProveedorNoEncontradaError,
  reexpresarFacturaUsd,
} from "@/lib/facturas-proveedor/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { reexpresarFacturaUsdSchema } from "@/lib/validations/facturas-proveedor";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Re-expresar en pesos una factura en dólares (D-4). Solo ADMIN.
 * Body: `{ valor, trmCentavos, fechaTrm?, motivo, confirmarValorUsd? }`.
 * 409 `FACTURA_YA_COBRADA`, 409 `USD_VALOR_LEJOS_DE_TRM`,
 * 422 `REEXPRESION_USD_INVALIDA` (factura en pesos o valor por debajo de lo pagado).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = reexpresarFacturaUsdSchema.parse(await request.json());
    const factura = await reexpresarFacturaUsd(id, payload, session.user.id);
    return jsonResponse({ factura });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (error instanceof CxpError) {
      return jsonResponse(cuerpoErrorCxp(error), { status: error.status });
    }
    if (error instanceof FacturaProveedorNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (isDomainError(error)) {
      const codigo = (error as { codigo?: unknown }).codigo;
      return typeof codigo === "string"
        ? NextResponse.json({ error: error.message, codigo }, { status: error.status })
        : domainErrorResponse(error);
    }
    throw error;
  }
}
