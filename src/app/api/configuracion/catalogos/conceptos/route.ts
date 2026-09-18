import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  actualizarConceptoVenta,
  crearConceptoVenta,
  listarConceptosVenta,
} from "@/lib/catalogos/conceptos-service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  conceptoVentaActualizarSchema,
  conceptoVentaCrearSchema,
} from "@/lib/validations/catalogos";

/** GET — maestro de conceptos de venta. ADMIN configura, REVISOR consulta. */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const soloActivos = request.nextUrl.searchParams.get("activos") === "1";
  const conceptos = await listarConceptosVenta({ soloActivos });

  return jsonResponse({ conceptos, total: conceptos.length });
}

/** POST — crea un concepto. Solo ADMIN. */
export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const payload = conceptoVentaCrearSchema.parse(await request.json());
    const concepto = await crearConceptoVenta(payload, session.user.id);
    return jsonResponse({ concepto }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}

/** PATCH — edita un concepto (`{ id, ...campos }`). El código no se cambia. */
export async function PATCH(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const payload = conceptoVentaActualizarSchema.parse(await request.json());
    const concepto = await actualizarConceptoVenta(payload, session.user.id);
    return jsonResponse({ concepto });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
