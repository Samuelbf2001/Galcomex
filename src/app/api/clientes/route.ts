import { Prisma, TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  clienteFieldsQuerySchema,
  clientePayloadSchema,
  tipoClienteQuerySchema,
} from "@/lib/validations/clientes";

/**
 * GET /api/clientes?tipo=&fields=
 *
 * - Sin `fields`: listado completo con tarifas (comportamiento histórico).
 * - `fields=options`: solo `{ id, nombre, nit, tipo, activo }`, sin tarifas —
 *   para selects/combos que no necesitan el detalle.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  let tipo: ReturnType<typeof tipoClienteQuerySchema.parse>;
  let fields: ReturnType<typeof clienteFieldsQuerySchema.parse>;
  try {
    tipo = tipoClienteQuerySchema.parse(
      request.nextUrl.searchParams.get("tipo") ?? undefined,
    );
    fields = clienteFieldsQuerySchema.parse(
      request.nextUrl.searchParams.get("fields") ?? undefined,
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  const where: Prisma.ClienteWhereInput = {};

  if (session.user.rol === "SOCIO") {
    where.tipo = TipoCliente.SOCIO_LM;
  } else if (tipo) {
    where.tipo = tipo;
  }

  if (fields === "options") {
    const clientes = await prisma.cliente.findMany({
      where,
      orderBy: { nombre: "asc" },
      select: { id: true, nombre: true, nit: true, tipo: true, activo: true },
    });

    return jsonResponse({ clientes });
  }

  const clientes = await prisma.cliente.findMany({
    where,
    orderBy: { nombre: "asc" },
    include: {
      tarifas: {
        orderBy: [{ anio: "desc" }, { tipo: "asc" }],
      },
    },
  });

  return jsonResponse({ clientes });
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = clientePayloadSchema.parse(await request.json());
    const { tarifas, ...cliente } = payload;

    const created = await prisma.cliente.create({
      data: {
        ...cliente,
        tarifas: {
          create: tarifas,
        },
      },
      include: { tarifas: true },
    });

    return jsonResponse({ cliente: created }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Ya existe un cliente con ese NIT" },
        { status: 409 },
      );
    }

    throw error;
  }
}
