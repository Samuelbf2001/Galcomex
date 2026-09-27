import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { CxpError, cuerpoErrorCxp } from "@/lib/cxp/errores";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  actualizarBeneficiario,
  BeneficiarioNoEncontradoError,
  EmpresaNoEncontradaParaBeneficiarioError,
} from "@/lib/beneficiarios/service";
import { actualizarBeneficiarioSchema } from "@/lib/validations/beneficiarios";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Edición de ficha de pago. Mismos códigos que el alta cuando cambia el NIT;
 * 409 `FACTURA_DUPLICADA` si con el NIT nuevo una factura de la ficha quedaría
 * repetida con otra del mismo proveedor.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  let payload: ReturnType<typeof actualizarBeneficiarioSchema.parse>;
  try {
    payload = actualizarBeneficiarioSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    const beneficiario = await actualizarBeneficiario(id, payload, session.user.id, {
      permitirMismoNit: payload.otraCuentaMismoProveedor === true && session.user.rol === "ADMIN",
    });
    return jsonResponse({ beneficiario });
  } catch (error) {
    if (error instanceof BeneficiarioNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof CxpError) return jsonResponse(cuerpoErrorCxp(error), { status: error.status });
    if (error instanceof EmpresaNoEncontradaParaBeneficiarioError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
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
