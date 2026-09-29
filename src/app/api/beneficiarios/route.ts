import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { CxpError, cuerpoErrorCxp } from "@/lib/cxp/errores";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  crearBeneficiario,
  EmpresaNoEncontradaParaBeneficiarioError,
  listarBeneficiarios,
} from "@/lib/beneficiarios/service";
import { crearBeneficiarioSchema } from "@/lib/validations/beneficiarios";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);
  if (session instanceof NextResponse) return session;

  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const empresaId = request.nextUrl.searchParams.get("empresaId") ?? undefined;
  const beneficiarios = await listarBeneficiarios(q, empresaId);

  return jsonResponse({ beneficiarios });
}

/**
 * Alta de ficha de pago (CxP v2). Errores `{ error, codigo, detalles? }`:
 * 422 `NIT_DV_INVALIDO`, 422 `NIT_NO_COINCIDE_EMPRESA`, 409 `BENEFICIARIO_EXISTE`
 * (`detalles.existente`; solo ADMIN puede forzar con `otraCuentaMismoProveedor`),
 * 409 `POSIBLE_BENEFICIARIO_DUPLICADO` (`detalles.existentes`; reenviar con
 * `confirmarOtraFicha: true`).
 */
export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const payload = crearBeneficiarioSchema.parse(await request.json());
    const beneficiario = await crearBeneficiario(payload, session.user.id, {
      permitirMismoNit: payload.otraCuentaMismoProveedor === true && session.user.rol === "ADMIN",
    });
    return jsonResponse({ beneficiario }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
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
