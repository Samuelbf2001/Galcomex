import { Prisma, TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { getUmbralesAlertaTramite, umbralParaEmpresa } from "@/lib/alertas/umbrales";
import { requireRole } from "@/lib/auth/session";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { assertTramiteModificable } from "@/lib/tramites/guard";
import { tramiteDetalleInclude, tramiteInclude } from "@/lib/tramites/service";
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

    const tramite = await prisma.$transaction(async (tx) => {
      await assertTramiteModificable(tx, before);

      const updated = await tx.tramiteDO.update({
        where: { id },
        data: payload,
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

    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
