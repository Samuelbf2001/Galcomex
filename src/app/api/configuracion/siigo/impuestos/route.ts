import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";

export async function GET(_request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  const [impuestos, total] = await prisma.$transaction([
    prisma.siigoImpuesto.findMany({
      orderBy: [{ activo: "desc" }, { tipo: "asc" }, { nombre: "asc" }],
    }),
    prisma.siigoImpuesto.count(),
  ]);

  const ultimaSync = await prisma.auditLog.findFirst({
    where: { entidad: "SiigoImpuesto", accion: "SYNC" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return jsonResponse({
    impuestos,
    total,
    ultimaSync: ultimaSync?.createdAt ?? null,
  });
}
