import { NextResponse, type NextRequest } from "next/server";

import { prisma as db } from "@/lib/db/prisma";
import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { generatePseToken } from "@/lib/crypto/pse";
import { CLAVES_UMBRAL, DEFAULTS_UMBRAL, getParametroNumero } from "@/lib/parametros/service";

type RouteContext = { params: Promise<{ id: string }> };

const WEBHOOK_PSE_URL =
  process.env.WEBHOOK_PSE_URL ??
  "https://n8n.sixteam.pro/webhook/b53a9bb0-5904-4a9a-9828-5eeb2243e4df";

export async function POST(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  const tramite = await db.tramiteDO.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!tramite) {
    return NextResponse.json({ error: "Trámite no encontrado." }, { status: 404 });
  }

  // Vigencia del ENLACE (no del código): configurable vía
  // PSE_TOKEN_VIGENCIA_SEGUNDOS, default 1800s = 30 min — tiempo razonable
  // para que el operario abra el WhatsApp y lo reenvíe.
  const vigenciaSegundos = await getParametroNumero(
    CLAVES_UMBRAL.pseTokenVigenciaSegundos,
    DEFAULTS_UMBRAL.pseTokenVigenciaSegundos,
  );

  const token = generatePseToken();
  const expiresAt = new Date(Date.now() + vigenciaSegundos * 1000);

  await db.pseSolicitud.create({
    data: { tramiteId: id, token, solicitadoPor: session.user.id, expiresAt },
  });

  const linkPse = `pse/${token}`;

  // Notifica a María Camila vía n8n con el link seguro (fire-and-forget)
  fetch(WEBHOOK_PSE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: linkPse,
    }),
  }).catch(() => {
    console.error("[PSE] No se pudo notificar a n8n para tramite", id);
  });

  return jsonResponse({ ok: true, solicitudId: token });
}
