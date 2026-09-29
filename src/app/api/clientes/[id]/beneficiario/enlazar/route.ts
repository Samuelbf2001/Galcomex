import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { confirmaOtraFicha, respuestaErrorFicha } from "@/lib/beneficiarios/http";
import {
  EmpresaNoEncontradaError,
  enlazarBeneficiarioEmpresa,
} from "@/lib/beneficiarios/service";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Enlazar con un clic la ficha de pago (beneficiario) de una empresa (M5): si
 * ya tiene una enlazada la devuelve tal cual, si no busca una existente por
 * NIT base (sin DV, puntos ni espacios) y si tampoco hay crea una nueva.
 * Solo ADMIN — mismo rol que gestiona beneficiarios y capacidades de empresa.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const beneficiario = await enlazarBeneficiarioEmpresa(id, session.user.id, {
      confirmarOtraFicha: confirmaOtraFicha(request.nextUrl),
    });

    return jsonResponse({ beneficiario });
  } catch (error) {
    if (error instanceof EmpresaNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const errorFicha = respuestaErrorFicha(error);
    if (errorFicha) return errorFicha;
    throw error;
  }
}
