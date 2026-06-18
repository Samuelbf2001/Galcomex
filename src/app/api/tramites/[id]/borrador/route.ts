/**
 * POST /api/tramites/[id]/borrador  — Generar borrador de factura (rol ADMIN)
 * GET  /api/tramites/[id]/borrador  — Listar borradores del trámite
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import {
  ConceptosOperacionalesInvalidosError,
  TramiteNoFacturableError,
  generarBorrador,
  listarBorradores,
} from "@/lib/borradores/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { generarBorradorPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "REVISOR", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id: tramiteId } = await params;

  const permiso = await resolverTramiteConPermiso(tramiteId, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const borradores = await listarBorradores(tramiteId);

  return jsonResponse({ borradores });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id: tramiteId } = await params;

  try {
    const payload = generarBorradorPayloadSchema.parse(await request.json());

    const borrador = await generarBorrador({
      tramiteId,
      comision: payload.comision,
      ivaComision: payload.ivaComision,
      montoLM: payload.montoLM,
      retenciones: payload.retenciones,
      conceptosOperacionales: payload.conceptosOperacionales,
      usuarioId: session.user.id,
    });

    return jsonResponse({ borrador }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (error instanceof ConceptosOperacionalesInvalidosError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof TramiteNoFacturableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
}
