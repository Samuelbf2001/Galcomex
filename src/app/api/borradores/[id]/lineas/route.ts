/**
 * POST /api/borradores/[id]/lineas — Crear línea manual de la factura de venta.
 * Roles ADMIN y SOCIO (SOCIO restringido a trámites de clientes SOCIO_LM).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import {
  BorradorNoEditableError,
  BorradorNoEncontradoError,
  FacturaDeOtroTramiteError,
  crearLineaManual,
} from "@/lib/borradores/lineas-service";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { crearLineaPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "SOCIO"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId } = await params;

  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: { tramiteId: true },
  });
  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  const permiso = await resolverTramiteConPermiso(borrador.tramiteId, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  try {
    const payload = crearLineaPayloadSchema.parse(await request.json());

    const actualizado = await crearLineaManual({
      borradorId,
      concepto: payload.concepto,
      numSoporte: payload.numSoporte,
      valor: payload.valor,
      observacion: payload.observacion,
      facturaIds: payload.facturaIds,
      usuarioId: session.user.id,
    });

    return jsonResponse({ borrador: actualizado }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (
      error instanceof BorradorNoEncontradoError ||
      error instanceof BorradorNoEditableError ||
      error instanceof FacturaDeOtroTramiteError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
