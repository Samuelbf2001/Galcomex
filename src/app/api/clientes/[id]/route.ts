import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { clienteUpdateSchema } from "@/lib/validations/clientes";

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
  const cliente = await prisma.cliente.findUnique({
    where: { id },
    include: {
      tarifas: { orderBy: [{ anio: "desc" }, { tipo: "asc" }] },
      tramites: {
        orderBy: { createdAt: "desc" },
        select: { id: true, consecutivo: true, estado: true, ciudad: true },
      },
      anticipos: {
        orderBy: { fecha: "desc" },
        include: {
          aplicaciones: { select: { montoAplicado: true } },
        },
      },
      facturas: {
        orderBy: { fecha: "desc" },
        select: {
          id: true,
          numSiigo: true,
          fecha: true,
          totalFactura: true,
          saldoAFavorCliente: true,
          saldoACargoCliente: true,
          fechaPagoCliente: true,
        },
      },
    },
  });

  if (!cliente || (session.user.rol === "SOCIO" && cliente.tipo !== "SOCIO_LM")) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }

  return jsonResponse({ cliente });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = clienteUpdateSchema.parse(await request.json());
    const { tarifas, ...clienteData } = payload;

    const updated = await prisma.$transaction(async (tx) => {
      const nextCliente = await tx.cliente.update({
        where: { id },
        data: clienteData,
      });

      if (tarifas) {
        await tx.tarifaCliente.deleteMany({ where: { clienteId: id } });
        await tx.tarifaCliente.createMany({
          data: tarifas.map((tarifa) => ({
            ...tarifa,
            clienteId: id,
          })),
        });
      }

      return tx.cliente.findUniqueOrThrow({
        where: { id: nextCliente.id },
        include: { tarifas: { orderBy: [{ anio: "desc" }, { tipo: "asc" }] } },
      });
    });

    return jsonResponse({ cliente: updated });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
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

export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = clienteUpdateSchema.parse(await request.json());
    const { tarifas, ...cliente } = payload;

    const updated = await prisma.$transaction(async (tx) => {
      const nextCliente = await tx.cliente.update({
        where: { id },
        data: cliente,
      });

      if (tarifas) {
        await tx.tarifaCliente.deleteMany({ where: { clienteId: id } });
        await tx.tarifaCliente.createMany({
          data: tarifas.map((tarifa) => ({
            ...tarifa,
            clienteId: id,
          })),
        });
      }

      return tx.cliente.findUniqueOrThrow({
        where: { id: nextCliente.id },
        include: { tarifas: { orderBy: [{ anio: "desc" }, { tipo: "asc" }] } },
      });
    });

    return jsonResponse({ cliente: updated });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
    }

    throw error;
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    await prisma.cliente.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        { error: "No se puede borrar un cliente con tramites asociados" },
        { status: 409 },
      );
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
    }

    throw error;
  }
}
