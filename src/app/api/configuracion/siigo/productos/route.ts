import { NextResponse, type NextRequest } from "next/server";
import { ZodError, z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import type { Prisma } from "@prisma/client";

const querySchema = z.object({
  q: z.string().trim().min(1).optional(),
  soloActivos: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  take: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  let query: z.infer<typeof querySchema>;
  try {
    query = querySchema.parse({
      q: request.nextUrl.searchParams.get("q") ?? undefined,
      soloActivos: request.nextUrl.searchParams.get("soloActivos") ?? undefined,
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const where: Prisma.SiigoProductoWhereInput = {};

  if (query.soloActivos) {
    where.activo = true;
  }

  if (query.q) {
    where.OR = [
      { nombre: { contains: query.q, mode: "insensitive" } },
      { codigo: { contains: query.q, mode: "insensitive" } },
    ];
  }

  const [productos, total] = await prisma.$transaction([
    prisma.siigoProducto.findMany({
      where,
      orderBy: [{ activo: "desc" }, { codigo: "asc" }],
      take: query.take,
      skip: query.skip,
      include: {
        impuestos: {
          include: {
            impuesto: {
              select: { id: true, nombre: true, tipo: true, porcentaje: true },
            },
          },
        },
      },
    }),
    prisma.siigoProducto.count({ where }),
  ]);

  const ultimaSync = await prisma.auditLog.findFirst({
    where: { entidad: "SiigoProducto", accion: "SYNC" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return jsonResponse({
    productos,
    total,
    ultimaSync: ultimaSync?.createdAt ?? null,
  });
}
