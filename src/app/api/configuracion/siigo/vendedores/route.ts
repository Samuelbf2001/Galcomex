import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";

export async function GET(_request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const vendedores = await prisma.siigoVendedor.findMany({
    orderBy: [{ nombre: "asc" }, { id: "asc" }],
    select: {
      id: true,
      username: true,
      nombre: true,
      email: true,
      activo: true,
      sincronizadoEn: true,
    },
  });

  const ultimaSync = vendedores.reduce<Date | null>((max, v) => {
    return !max || v.sincronizadoEn > max ? v.sincronizadoEn : max;
  }, null);

  return jsonResponse({
    vendedores,
    total: vendedores.length,
    ultimaSync: ultimaSync ? ultimaSync.toISOString() : null,
  });
}
