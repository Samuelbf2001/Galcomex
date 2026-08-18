import { NextResponse, type NextRequest } from "next/server";

import { prisma as db } from "@/lib/db/prisma";
import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { generatePseToken } from "@/lib/crypto/pse";
import { CLAVES_UMBRAL, DEFAULTS_UMBRAL, getParametroNumero } from "@/lib/parametros/service";
import { enviarWebhookFirmado } from "@/lib/webhooks/dispatch";

type RouteContext = { params: Promise<{ id: string }> };

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

  // Notifica a María Camila vía n8n con el link seguro (fire-and-forget).
  //
  // Payload se mantiene EXACTAMENTE `{ url: linkPse }` — hay un flujo n8n en
  // producción que ya lo consume así. NO cambiar la forma sin actualizar
  // ese flujo primero. Lo único que cambia acá es que ahora viaja firmado
  // (X-Galcomex-Signature / X-Galcomex-Timestamp, ver src/lib/webhooks) y
  // que la URL sale de WEBHOOK_PSE_URL sin fallback hardcodeado — si no
  // está configurada, no se envía nada (no-op silencioso con log, ver
  // enviarWebhookFirmado).
  const bodyPse = JSON.stringify({ url: linkPse });
  void enviarWebhookFirmado({
    url: process.env.WEBHOOK_PSE_URL,
    secreto: process.env.WEBHOOK_SECRET,
    body: bodyPse,
    etiqueta: `pse-token:${id}`,
  });

  return jsonResponse({ ok: true, solicitudId: token });
}
