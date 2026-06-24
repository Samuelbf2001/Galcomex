import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";

export async function GET(_request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const tipos = await prisma.siigoTipoComprobante.findMany({
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      code: true,
      nombre: true,
      tipo: true,
      activo: true,
      sincronizadoEn: true,
    },
  });

  const ultimaSync = tipos.reduce<Date | null>((max, t) => {
    return !max || t.sincronizadoEn > max ? t.sincronizadoEn : max;
  }, null);

  return jsonResponse({
    tiposComprobante: tipos,
    total: tipos.length,
    ultimaSync: ultimaSync ? ultimaSync.toISOString() : null,
  });
}
