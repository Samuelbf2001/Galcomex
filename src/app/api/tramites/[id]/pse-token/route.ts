import { NextResponse, type NextRequest } from "next/server";

import { prisma as db } from "@/lib/db/prisma";
import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { generatePseToken } from "@/lib/crypto/pse";

type RouteContext = { params: Promise<{ id: string }> };

const WEBHOOK_PSE_URL =
  process.env.WEBHOOK_PSE_URL ??
  "https://n8n.sixteam.pro/webhook/b53a9bb0-5904-4a9a-9828-5eeb2243e4df";


// El link expira en 30 minutos (tiempo estándar de vigencia PSE)
const EXPIRY_MS = 30 * 60 * 1000;

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

  const token = generatePseToken();
  const expiresAt = new Date(Date.now() + EXPIRY_MS);

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
