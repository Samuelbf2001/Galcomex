import { Prisma, TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { createTramite, tramiteInclude } from "@/lib/tramites/service";
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
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  const where: Prisma.TramiteDOWhereInput = {};

  if (query.estado) {
    where.estado = query.estado;
  }

  if (query.ciudad) {
    where.ciudad = query.ciudad;
  }

  if (query.clienteId) {
    where.clienteId = query.clienteId;
  }

  if (query.q) {
    where.OR = [
      { consecutivo: { contains: query.q, mode: "insensitive" } },
      { doAgencia: { contains: query.q, mode: "insensitive" } },
      { doCliente: { contains: query.q, mode: "insensitive" } },
      { cliente: { nombre: { contains: query.q, mode: "insensitive" } } },
    ];
  }

  if (session.user.rol === "SOCIO") {
    where.cliente = { tipo: TipoCliente.SOCIO_LM };
  }

  const [tramites, total] = await prisma.$transaction([
    prisma.tramiteDO.findMany({
      where,
      orderBy: [{ anio: "desc" }, { ciudad: "asc" }, { numero: "desc" }],
      take: query.take,
      skip: query.skip,
      include: tramiteInclude,
    }),
    prisma.tramiteDO.count({ where }),
  ]);

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
