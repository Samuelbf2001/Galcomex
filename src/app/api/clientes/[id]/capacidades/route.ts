import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { capacidadesParaFicha, setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { capacidadesPayloadSchema } from "@/lib/validations/capacidades";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/**
 * Interruptores de función de una empresa (M1 del PLAN-CONFIGURABILIDAD).
 * GET lo lee cualquier rol autenticado —la ficha los muestra en modo lectura—;
 * solo ADMIN los cambia.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  const cliente = await prisma.cliente.findUnique({
    where: { id },
    select: { id: true, tipo: true },
  });

  if (!cliente || (session.user.rol === "SOCIO" && cliente.tipo !== "SOCIO_LM")) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }

  const capacidades = await capacidadesParaFicha(id);

  return jsonResponse({ capacidades });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = capacidadesPayloadSchema.parse(await request.json());

    await setCapacidadesEmpresa({
      empresaId: id,
      cambios: payload.cambios,
      usuarioId: session.user.id,
    });

    const capacidades = await capacidadesParaFicha(id);

    return jsonResponse({ capacidades });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
