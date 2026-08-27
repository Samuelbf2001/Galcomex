import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { createTramite, listTramites } from "@/lib/tramites/service";
import {
  tramiteCreateSchema,
  tramiteQuerySchema,
} from "@/lib/validations/tramites";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  let query: ReturnType<typeof tramiteQuerySchema.parse>;
  try {
    query = tramiteQuerySchema.parse({
      q: request.nextUrl.searchParams.get("q") ?? undefined,
      estado: request.nextUrl.searchParams.get("estado") ?? undefined,
      ciudad: request.nextUrl.searchParams.get("ciudad") ?? undefined,
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      tipoCliente: request.nextUrl.searchParams.get("tipoCliente") ?? undefined,
      facturado: request.nextUrl.searchParams.get("facturado") ?? undefined,
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  // Scoping del rol SOCIO: solo ve tramites de clientes tipo SOCIO_LM.
  // Se combina (AND) con los filtros de la query dentro de listTramites y
  // nunca se debilita — ver comentario en TramiteListOptions.socioScope.
  const { tramites, total } = await listTramites(query, {
    socioScope: session.user.rol === "SOCIO",
  });

  return jsonResponse({ tramites, total });
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = tramiteCreateSchema.parse(await request.json());
    const tramite = await createTramite({
      ...payload,
      eta: payload.eta ?? undefined,
      creadoPorId: session.user.id,
    });

    return jsonResponse({ tramite }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        { error: "Cliente o usuario relacionado no existe" },
        { status: 400 },
      );
    }

    throw error;
  }
}
