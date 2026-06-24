import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  actualizarBeneficiario,
  BeneficiarioNoEncontradoError,
} from "@/lib/beneficiarios/service";
import { actualizarBeneficiarioSchema } from "@/lib/validations/beneficiarios";

type RouteParams = { params: Promise<{ id: string }> };

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
    const beneficiario = await actualizarBeneficiario(id, payload);
    return jsonResponse({ beneficiario });
  } catch (error) {
    if (error instanceof BeneficiarioNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
