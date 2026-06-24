import { NextResponse, type NextRequest } from "next/server";
import { ZodError, z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteParams = { params: Promise<{ id: string }> };

const putSchema = z.object({
  impuestoIds: z.array(z.number().int()).max(20),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const { id: productoId } = await params;

  let payload: z.infer<typeof putSchema>;
  try {
    payload = putSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const producto = await prisma.siigoProducto.findUnique({
    where: { id: productoId },
    select: { id: true },
  });
  if (!producto) {
    return NextResponse.json({ error: "Producto no encontrado" }, { status: 404 });
  }

  if (payload.impuestoIds.length > 0) {
    const existentes = await prisma.siigoImpuesto.findMany({
      where: { id: { in: payload.impuestoIds } },
      select: { id: true },
    });
    if (existentes.length !== payload.impuestoIds.length) {
      return NextResponse.json(
        { error: "Uno o más impuestos no existen en el catálogo local" },
        { status: 422 },
      );
    }
  }

  const antes = await prisma.siigoProductoImpuesto.findMany({
    where: { productoId },
    select: { impuestoId: true },
  });

  await prisma.$transaction([
    prisma.siigoProductoImpuesto.deleteMany({ where: { productoId } }),
    prisma.siigoProductoImpuesto.createMany({
      data: payload.impuestoIds.map((impuestoId) => ({ productoId, impuestoId })),
    }),
    prisma.auditLog.create({
      data: {
        entidad: "SiigoProductoImpuesto",
        entidadId: productoId,
        accion: "UPDATE",
        usuarioId: session.user.id,
        antes: { impuestoIds: antes.map((a) => a.impuestoId) },
        despues: { impuestoIds: payload.impuestoIds },
      },
    }),
  ]);

  return jsonResponse({ ok: true, impuestoIds: payload.impuestoIds });
}
