/**
 * PATCH /api/borradores/[id]  — Transición de estado / aprobar / facturar
 *
 * - Mover a EN_REVISION: rol ADMIN u OPERATIVO
 * - Aprobar (→APROBADO): rol REVISOR o ADMIN
 * - Facturar (→FACTURADO): rol ADMIN (requiere numFacturaSiigo + fechaFactura)
 */

import { EstadoBorrador } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { transicionarBorrador } from "@/lib/borradores/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { transicionBorradorPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id: borradorId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let payload: ReturnType<typeof transicionBorradorPayloadSchema.parse>;
  try {
    payload = transicionBorradorPayloadSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  // Validar rol según la acción
  const { nuevoEstado } = payload;

  let session: Awaited<ReturnType<typeof requireRole>>;

  if (nuevoEstado === EstadoBorrador.APROBADO) {
    // Solo REVISOR o ADMIN pueden aprobar
    session = await requireRole(["REVISOR", "ADMIN"]);
  } else if (nuevoEstado === EstadoBorrador.FACTURADO) {
    // Solo ADMIN puede facturar
    session = await requireRole(["ADMIN"]);
  } else {
    // Mover a EN_REVISION: ADMIN u OPERATIVO
    session = await requireRole(["ADMIN", "OPERATIVO"]);
  }

  if (session instanceof NextResponse) {
    return session;
  }

  const result = await transicionarBorrador({
    borradorId,
    nuevoEstado,
    usuarioId: session.user.id,
    numFacturaSiigo: payload.numFacturaSiigo,
    fechaFactura: payload.fechaFactura,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  return jsonResponse({ borrador: result.borrador });
}
