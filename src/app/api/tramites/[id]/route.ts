import { Prisma, TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
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

  return jsonResponse({ tramite });
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
          antes: before,
          despues: updated,
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

    throw error;
  }
}
