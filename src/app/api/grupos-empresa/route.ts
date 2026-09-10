import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

/**
 * Grupos económicos (M5): agrupan empresas de la misma casa —Polired y Polired
 * Zona Franca, por ejemplo— para que una función encendida en el grupo aplique
 * a todas sus empresas.
 */
const crearGrupoSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(120),
});

export async function GET() {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const grupos = await prisma.grupoEmpresa.findMany({
    orderBy: { nombre: "asc" },
    include: {
      empresas: { select: { id: true, nombre: true, nit: true }, orderBy: { nombre: "asc" } },
      capacidades: { select: { codigo: true, habilitado: true, config: true } },
    },
  });

  return jsonResponse({ grupos });
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = crearGrupoSchema.parse(await request.json());
    const grupo = await prisma.grupoEmpresa.create({ data: payload });

    return jsonResponse({ grupo }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Ya existe un grupo económico con ese nombre" },
        { status: 409 },
      );
    }

    throw error;
  }
}
