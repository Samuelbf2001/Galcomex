/**
 * PATCH  /api/borradores/[id]/lineas/[lineaId] — Editar línea manual + revincular facturas.
 * DELETE /api/borradores/[id]/lineas/[lineaId] — Eliminar línea manual.
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
  LineaNoEncontradaError,
  actualizarLinea,
  eliminarLinea,
} from "@/lib/borradores/lineas-service";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { actualizarLineaPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string; lineaId: string }> };

/** Resuelve el borrador, valida que la línea le pertenezca y aplica el gate SOCIO_LM. */
async function autorizar(
  borradorId: string,
  lineaId: string,
  rol: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const linea = await prisma.lineaRevision.findUnique({
    where: { id: lineaId },
    select: { borradorId: true, borrador: { select: { tramiteId: true } } },
  });
  if (!linea || linea.borradorId !== borradorId) {
    return { ok: false, response: NextResponse.json({ error: "Línea no encontrada" }, { status: 404 }) };
  }

  const permiso = await resolverTramiteConPermiso(linea.borrador.tramiteId, rol);
  if (permiso === null) {
    return { ok: false, response: NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 }) };
  }
  if (permiso === "forbidden") {
    return { ok: false, response: NextResponse.json({ error: "No autorizado" }, { status: 403 }) };
  }
  return { ok: true };
}

function mapError(error: unknown): NextResponse | null {
  if (error instanceof ZodError) {
    return validationError(error);
  }
  if (
    error instanceof BorradorNoEncontradoError ||
    error instanceof BorradorNoEditableError ||
    error instanceof FacturaDeOtroTramiteError ||
    error instanceof LineaNoEncontradaError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "SOCIO"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId, lineaId } = await params;

  const auth = await autorizar(borradorId, lineaId, session.user.rol);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const payload = actualizarLineaPayloadSchema.parse(await request.json());

    const actualizado = await actualizarLinea({
      lineaId,
      concepto: payload.concepto,
      numSoporte: payload.numSoporte,
      valor: payload.valor,
      observacion: payload.observacion,
      seccion: payload.seccion,
      facturaIds: payload.facturaIds,
      usuarioId: session.user.id,
    });

    return jsonResponse({ borrador: actualizado });
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return mapped;
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "SOCIO"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId, lineaId } = await params;

  const auth = await autorizar(borradorId, lineaId, session.user.rol);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const actualizado = await eliminarLinea(lineaId, session.user.id);
    return jsonResponse({ borrador: actualizado });
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return mapped;
    throw error;
  }
}
