import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
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

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const payload = crearBeneficiarioSchema.parse(await request.json());
    const beneficiario = await crearBeneficiario(payload, session.user.id);
    return jsonResponse({ beneficiario }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (error instanceof EmpresaNoEncontradaParaBeneficiarioError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
