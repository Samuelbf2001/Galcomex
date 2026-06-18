import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { checklistUpdateSchema } from "@/lib/validations/tramites";

type RouteContext = {
  params: Promise<{
    id: string;
    itemId: string;
  }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id, itemId } = await context.params;
    const payload = checklistUpdateSchema.parse(await request.json());
    const item = await prisma.checklistItem.update({
      where: { id: itemId, tramiteId: id },
      data: {
        recibido: payload.recibido,
        validadoPorId: payload.recibido ? session.user.id : null,
        fechaValidacion: payload.recibido ? new Date() : null,
      },
    });

    return jsonResponse({ item });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Item de checklist no encontrado" },
        { status: 404 },
      );
    }

    throw error;
  }
}
