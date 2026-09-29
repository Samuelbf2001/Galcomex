/**
 * POST /api/tramites/[id]/borrador  — Generar borrador de factura (rol ADMIN)
 * GET  /api/tramites/[id]/borrador  — Listar borradores del trámite
 *
 * El GET delega en `cargarBorradoresDeTramite` (src/lib/borradores/consulta.ts),
 * la misma función que usa el endpoint por lote GET /api/facturacion/borradores:
 * permiso/scope del trámite → ensureBorrador → listarBorradores.
 * El POST devuelve el borrador con `pagosPorRevisar` (como el GET) para que
 * el aviso del revisor salga desde que se genera.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  ROLES_CONSULTA_BORRADORES,
  cargarBorradoresDeTramite,
  conPagosPorRevisarDeBorrador,
} from "@/lib/borradores/consulta";
import {
  ConceptosOperacionalesInvalidosError,
  TramiteNoFacturableError,
  generarBorrador,
} from "@/lib/borradores/service";
import { avisoSinGastosSinRomper } from "@/lib/borradores/aviso-sin-gastos";
import { evaluarOcSinRomper } from "@/lib/borradores/orden-compra-service";
import { prisma } from "@/lib/db/prisma";
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
      // Modal "Generar borrador": con el tarifario, o 409 si ya no aplica
      // (TarifarioNoAplicableError sale por isDomainError).
      usarTarifario: payload.usarTarifario,
      tarifarioIdEsperado: payload.tarifarioId,
      totalTarifarioEsperado: payload.totalTarifario,
      usuarioId: session.user.id,
    });

    // Con sus pagos por revisar (mismo rastro que lee el GET): el revisor se
    // abre con este borrador y debe mostrar el aviso desde el primer momento.
    // B4 — y con la orden de compra del cliente (si aplica): el aviso también sale desde el principio.
    const ordenCompra = await evaluarOcSinRomper(prisma, borrador.id);
    // M2 — aviso (no bloqueante) si el DO no tiene gastos pagados por Galcomex registrados.
    const avisoSinGastos = await avisoSinGastosSinRomper(tramiteId);
    return jsonResponse(
      {
        borrador: {
          ...(await conPagosPorRevisarDeBorrador(borrador, session.user.rol)),
          ...(ordenCompra ? { ordenCompra } : {}),
          avisoSinGastos,
        },
      },
      { status: 201 },
    );
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
