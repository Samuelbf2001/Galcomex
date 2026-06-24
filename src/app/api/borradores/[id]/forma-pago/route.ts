/**
 * PATCH /api/borradores/[id]/forma-pago
 *
 * Actualiza la forma de pago Siigo del borrador (contado vs crédito).
 * Se puede cambiar en cualquier estado previo a FACTURADO.
 * Roles: ADMIN, REVISOR.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";

const schema = z.object({
  formaPagoSiigoId: z.number().int().positive().nullable(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let payload: z.infer<typeof schema>;
  try {
    payload = schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: { id: true, estado: true },
  });

  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  if (borrador.estado === "FACTURADO") {
    return NextResponse.json(
      { error: "No se puede modificar un borrador ya facturado" },
      { status: 409 },
    );
  }

  const updated = await prisma.borradorFactura.update({
    where: { id: borradorId },
    data: { formaPagoSiigoId: payload.formaPagoSiigoId },
    select: { id: true, formaPagoSiigoId: true, formaPago: { select: { id: true, nombre: true } } },
  });

  return jsonResponse(updated);
}
