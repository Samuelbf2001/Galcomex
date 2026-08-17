import { NextResponse, type NextRequest } from "next/server";

import { prisma as db } from "@/lib/db/prisma";
import { requireRole } from "@/lib/auth/session";
import { decryptPseCode } from "@/lib/crypto/pse";
import { jsonResponse } from "@/lib/http/json";
import { CLAVES_UMBRAL, DEFAULTS_UMBRAL, getParametroNumero } from "@/lib/parametros/service";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/tramites/[id]/pse-codigo
 * Polling que usa el operador para saber si María Camila ya ingresó el código.
 *
 * A3 (reunión 1-jul-2026, discrepancia real): el código tiene vida corta —
 * PSE_CODIGO_VIGENCIA_SEGUNDOS (default 30s) contados desde `respondidaAt`,
 * no desde que el operario lo ve. Este endpoint es quien manda: una vez
 * vencido deja de entregar el código aunque siga cifrado en BD, así que un
 * refresh o un segundo dispositivo tampoco pueden leerlo tarde — la
 * obligación de "pedir uno nuevo" es real, no solo un countdown de UI.
 *
 * Devuelve { ready: false } o { ready: true, codigo: "E11027", expiraEnSegundos: 27 }
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  // Busca la solicitud PSE más reciente no expirada (enlace) para este trámite
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

  const vigenciaSegundos = await getParametroNumero(
    CLAVES_UMBRAL.pseCodigoVigenciaSegundos,
    DEFAULTS_UMBRAL.pseCodigoVigenciaSegundos,
  );

  const expiraEnMs = solicitud.respondidaAt.getTime() + vigenciaSegundos * 1000 - Date.now();

  if (expiraEnMs <= 0) {
    // El código ya cumplió su vigencia — no se entrega. El operario debe
    // solicitar uno nuevo (nuevo enlace, nuevo código).
    return jsonResponse({ ready: false, expirado: true });
  }

  const codigo = decryptPseCode(solicitud.codigoPseEnc);
  return jsonResponse({ ready: true, codigo, expiraEnSegundos: Math.ceil(expiraEnMs / 1000) });
}
