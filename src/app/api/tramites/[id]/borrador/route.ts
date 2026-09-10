/**
 * POST /api/tramites/[id]/borrador  — Generar borrador de factura (rol ADMIN)
 * GET  /api/tramites/[id]/borrador  — Listar borradores del trámite
 *
 * El GET delega en `cargarBorradoresDeTramite` (src/lib/borradores/consulta.ts),
 * la misma función que usa el endpoint por lote GET /api/facturacion/borradores:
 * permiso/scope del trámite → ensureBorrador → listarBorradores.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  ROLES_CONSULTA_BORRADORES,
  cargarBorradoresDeTramite,
} from "@/lib/borradores/consulta";
import {
  ConceptosOperacionalesInvalidosError,
  TramiteNoFacturableError,
  generarBorrador,
} from "@/lib/borradores/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { generarBorradorPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(ROLES_CONSULTA_BORRADORES);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id: tramiteId } = await params;

  try {
    // 404 "Trámite no encontrado" / 403 "No autorizado" salen como errores de
    // dominio tipados desde cargarBorradoresDeTramite.
    const resultado = await cargarBorradoresDeTramite(tramiteId, session.user);

    return jsonResponse(resultado);
  } catch (error) {
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
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

    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
