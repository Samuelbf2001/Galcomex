import { Prisma, TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { getUmbralesAlertaTramite, umbralParaEmpresa } from "@/lib/alertas/umbrales";
import { requireRole } from "@/lib/auth/session";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { verificarComisionesAlEditar } from "@/lib/comisiones/service";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { assertTramiteModificable } from "@/lib/tramites/guard";
import {
  tramiteDetalleInclude,
  tramiteInclude,
  TarifaVigenteRequeridaError,
  verificarContenedoresAlEditar,
  verificarServicioDelDo,
} from "@/lib/tramites/service";
import { ServicioNoPermitidoError, ServicioReservadoError } from "@/lib/tramites/servicios";
import { tramiteUpdateSchema } from "@/lib/validations/tramites";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id },
    include: tramiteDetalleInclude,
  });

  if (
    !tramite ||
    (session.user.rol === "SOCIO" && tramite.cliente.tipo !== TipoCliente.SOCIO_LM)
  ) {
    return NextResponse.json({ error: "Tramite no encontrado" }, { status: 404 });
  }

  // Umbral de alerta de saldo aplicable a este DO. Sale de la capacidad
  // `umbral_saldo_tramite` de la empresa si la tiene encendida y, si no, del
  // parámetro global por tipo de cliente (SOCIO_LM → socio; PROPIO → propio).
  // Alimenta el banner de la Hoja del trámite (components/tramites/hoja-tramite.tsx).
  const [umbrales, capacidades] = await Promise.all([
    getUmbralesAlertaTramite(),
    capacidadesDeEmpresa(tramite.clienteId),
  ]);
  const umbralAlertaSaldo = umbralParaEmpresa(
    capacidades,
    tramite.cliente.tipo,
    umbrales,
  );

  return jsonResponse({ tramite, umbralAlertaSaldo: umbralAlertaSaldo.toString() });
}

/** PATCH: alias of PUT — permite edición parcial de fechas clave desde el detalle. */
export const PATCH = PUT;

export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = tramiteUpdateSchema.parse(await request.json());
    const before = await prisma.tramiteDO.findUnique({ where: { id } });

    if (!before) {
      return NextResponse.json({ error: "Tramite no encontrado" }, { status: 404 });
    }

    // D3: no dejar sin contenedores un DO de una empresa que los exige, ni con
    // menos contenedores de los que ya llevan comisión (caso LTRANS).
    await verificarContenedoresAlEditar(before, payload);
    await verificarComisionesAlEditar(before, payload);
    // Servicio del DO: valor a mano solo en un tipo `flujoCorto`; el servicio,
    // en un «Otros» (no reservado) o en un tipo con catálogo (solo los suyos,
    // 30-sep-2026). Con un borrador ya generado o desde ENVIADO_A_FACTURAR
    // (A2/B-N2/B-N3), sin concepto en el estado combinado (B2) o, al cambiar
    // el servicio de un trámite normal, sin tarifa del servicio nuevo (D1),
    // responde 409/422 antes de guardar nada. `referenciaExterna` entra al
    // mismo chequeo de bloqueo (sale en "SERVICIO: …" de la factura) sin
    // afectar a otros tipos. Cambiar el servicio nunca cambia el número.
    const servicio = await verificarServicioDelDo({
      tipoTramiteCodigo: before.tipoTramiteCodigo,
      tramiteId: before.id,
      estadoActual: before.estado,
      antes: { valorServicio: before.valorServicio, conceptoServicioCodigo: before.conceptoServicioCodigo },
      valorServicio: payload.valorServicio,
      conceptoServicioCodigo: payload.conceptoServicioCodigo,
      referenciaExterna: payload.referenciaExterna,
      clienteId: before.clienteId,
      ciudad: before.ciudad,
    });
    // Lo que se guarda es lo resuelto (p. ej. EXPORTACION aunque llegue vacío).
    const data = servicio ? { ...payload, conceptoServicioCodigo: servicio.conceptoServicioCodigo } : payload;

    const tramite = await prisma.$transaction(async (tx) => {
      await assertTramiteModificable(tx, before);

      const updated = await tx.tramiteDO.update({
        where: { id },
        data,
        include: tramiteInclude,
      });

      await tx.auditLog.create({
        data: {
          entidad: "TramiteDO",
          entidadId: id,
          accion: "UPDATE",
          usuarioId: session.user.id,
          tramiteId: id,
          antes: normalizeSerializable(before),
          despues: normalizeSerializable(updated),
        },
      });

      return updated;
    });

    return jsonResponse({ tramite });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Tramite no encontrado" }, { status: 404 });
    }

    // Servicio (30-sep-2026): el código le dice a la pantalla qué pasó.
    if (error instanceof ServicioNoPermitidoError || error instanceof ServicioReservadoError) {
      return NextResponse.json({ error: error.message, codigo: error.codigo }, { status: error.status });
    }
    if (error instanceof TarifaVigenteRequeridaError) {
      return NextResponse.json(
        { error: error.message, codigo: error.codigo, detalles: error.detalles },
        { status: error.status },
      );
    }

    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
