import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  const where = {
    activo: true,
    ...(q
      ? {
          OR: [
            { nombre: { contains: q, mode: "insensitive" as const } },
            { codigo: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const productos = await prisma.siigoProducto.findMany({
    where,
    orderBy: { codigo: "asc" },
    take: 50,
    select: { id: true, codigo: true, nombre: true },
  });

  return jsonResponse({ productos });
}
