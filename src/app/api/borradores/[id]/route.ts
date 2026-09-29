/**
 * GET   /api/borradores/[id]  — Un borrador completo (B8: recargar tras el 409
 *   ANTICIPO_ACTUALIZADO, que no trae el borrador en la respuesta de PATCH).
 * PATCH /api/borradores/[id]  — Transición de estado / aprobar / facturar
 *
 * - Mover a EN_REVISION: rol ADMIN u OPERATIVO
 * - Aprobar (→APROBADO): rol REVISOR o ADMIN
 * - Facturar (→FACTURADO): rol ADMIN (requiere numFacturaSiigo + fechaFactura)
 */

import { EstadoBorrador } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { requireRole } from "@/lib/auth/session";
import { anticipoDelTramite } from "@/lib/borradores/anticipo-disponible";
import { avisoSinGastosSinRomper, borradorEnRevision } from "@/lib/borradores/aviso-sin-gastos";
import { FORMATO_CONCEPTOS_IVA } from "@/lib/borradores/formato-conceptos";
import { evaluarOcSinRomper } from "@/lib/borradores/orden-compra-service";
import { getBorradorCompleto, transicionarBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { transicionBorradorPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "REVISOR", "SOCIO"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId } = await params;

  const cabecera = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: { tramiteId: true },
  });
  if (!cabecera) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  const permiso = await resolverTramiteConPermiso(cabecera.tramiteId, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const completo = await getBorradorCompleto(borradorId);
  if (!completo) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  const anticipoDo =
    completo.formatoFactura === FORMATO_CONCEPTOS_IVA
      ? await anticipoDelTramite(prisma, completo.tramiteId, { excluirBorradorId: borradorId })
      : null;

  const ordenCompra = await evaluarOcSinRomper(prisma, borradorId);
  // M2 — aviso (no bloqueante) de que el DO no tiene gastos pagados por Galcomex; solo mientras se revisa.
  const avisoSinGastos = borradorEnRevision(completo.estado)
    ? await avisoSinGastosSinRomper(completo.tramiteId)
    : undefined;

  return jsonResponse({ borrador: { ...completo, anticipoDo, ordenCompra, avisoSinGastos } });
}

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

  try {
    const result = await transicionarBorrador({
      borradorId,
      nuevoEstado,
      usuarioId: session.user.id,
      numFacturaSiigo: payload.numFacturaSiigo,
      fechaFactura: payload.fechaFactura,
      // B4 — el servicio decide si el motivo alcanza: solo un ADMIN salta el freno de la OC.
      motivoExcepcionOc: payload.motivoExcepcionOc,
      rolUsuario: session.user.rol,
    });

    if (!result.ok) {
      return jsonResponse(
        {
          error: result.message,
          ...(result.codigo ? { codigo: result.codigo } : {}),
          ...(result.detalle !== undefined ? { detalle: result.detalle } : {}),
        },
        { status: result.status },
      );
    }

    // M1 (revisión de código, 28-sep-2026): devolver `anticipoDo` como el GET,
    // así el desglose y "asignado a mano" se ven sin recargar tras aprobar o
    // cambiar de estado.
    const anticipoDo =
      result.borrador && result.borrador.formatoFactura === FORMATO_CONCEPTOS_IVA
        ? await anticipoDelTramite(prisma, result.borrador.tramiteId, { excluirBorradorId: borradorId })
        : null;

    // B4 — igual con la orden de compra: si el PATCH no la devuelve, el aviso
    // desaparece hasta recargar (la lección de M1 con el anticipo).
    const ordenCompra = result.borrador ? await evaluarOcSinRomper(prisma, borradorId) : null;
    // M2 — igual con el aviso de gastos: si el PATCH no lo devuelve, desaparece hasta recargar.
    const avisoSinGastos =
      result.borrador && borradorEnRevision(result.borrador.estado)
        ? await avisoSinGastosSinRomper(result.borrador.tramiteId)
        : undefined;

    return jsonResponse({
      borrador: result.borrador ? { ...result.borrador, anticipoDo, ordenCompra, avisoSinGastos } : result.borrador,
    });
  } catch (error) {
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }
    throw error;
  }
}
