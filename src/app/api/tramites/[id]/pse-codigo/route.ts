import { NextResponse, type NextRequest } from "next/server";

import { prisma as db } from "@/lib/db/prisma";
import { requireRole } from "@/lib/auth/session";
import { decryptPseCode } from "@/lib/crypto/pse";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/tramites/[id]/pse-codigo
 * Polling que usa el operador para saber si María Camila ya ingresó el código.
 * Devuelve { ready: false } o { ready: true, codigo: "E11027" }
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  // Busca la solicitud PSE más reciente no expirada para este trámite
  const solicitud = await db.pseSolicitud.findFirst({
    where: {
      tramiteId: id,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { codigoPseEnc: true, respondidaAt: true },
  });

  if (!solicitud || !solicitud.codigoPseEnc || !solicitud.respondidaAt) {
    return jsonResponse({ ready: false });
  }

  const codigo = decryptPseCode(solicitud.codigoPseEnc);
  return jsonResponse({ ready: true, codigo });
}
