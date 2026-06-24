import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";

export async function GET(_request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const formasPago = await prisma.siigoFormaPago.findMany({
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      tipo: true,
      activo: true,
      sincronizadoEn: true,
    },
  });

  const ultimaSync = formasPago.reduce<Date | null>((max, fp) => {
    return !max || fp.sincronizadoEn > max ? fp.sincronizadoEn : max;
  }, null);

  return jsonResponse({
    formasPago,
    total: formasPago.length,
    ultimaSync: ultimaSync ? ultimaSync.toISOString() : null,
  });
}
