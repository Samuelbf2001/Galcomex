import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma as db } from "@/lib/db/prisma";
import { encryptPseCode } from "@/lib/crypto/pse";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ token: string }> };

/** GET /api/pse/[token] — valida el token y devuelve info del trámite (para la landing) */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { token } = await context.params;

  const solicitud = await db.pseSolicitud.findUnique({
    where: { token },
    select: {
      id: true,
      expiresAt: true,
      respondidaAt: true,
      anuladaAt: true,
      tramite: { select: { consecutivo: true } },
    },
  });

  if (!solicitud) {
    return NextResponse.json({ error: "Link inválido o expirado." }, { status: 404 });
  }

  if (solicitud.respondidaAt) {
    return NextResponse.json({ error: "Este link ya fue usado." }, { status: 409 });
  }

  // Reemplazada por una solicitud más nueva del mismo trámite = vencida para quien la abre.
  if (solicitud.expiresAt < new Date() || solicitud.anuladaAt) {
    return NextResponse.json({ error: "Este link ha expirado." }, { status: 410 });
  }

  return jsonResponse({ consecutivo: solicitud.tramite.consecutivo });
}

const bodySchema = z.object({
  codigo: z.string().min(1).max(50).trim(),
});

/** POST /api/pse/[token] — María Camila envía el código PSE */
export async function POST(request: NextRequest, context: RouteContext) {
  const { token } = await context.params;

  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Código inválido." }, { status: 400 });
  }

  const solicitud = await db.pseSolicitud.findUnique({
    where: { token },
    select: { id: true, expiresAt: true, respondidaAt: true, anuladaAt: true },
  });

  if (!solicitud) {
    return NextResponse.json({ error: "Link inválido o expirado." }, { status: 404 });
  }

  if (solicitud.respondidaAt) {
    return NextResponse.json({ error: "Este link ya fue usado." }, { status: 409 });
  }

  if (solicitud.expiresAt < new Date() || solicitud.anuladaAt) {
    return NextResponse.json({ error: "Este link ha expirado." }, { status: 410 });
  }

  const codigoPseEnc = encryptPseCode(parsed.data.codigo);

  // Condicionado: si por WhatsApp ya llegó otro código, el del enlace no lo pisa.
  const { count } = await db.pseSolicitud.updateMany({
    where: { id: solicitud.id, respondidaAt: null, anuladaAt: null },
    data: { codigoPseEnc, respondidaAt: new Date(), canal: "ENLACE" },
  });
  if (count === 0) {
    return NextResponse.json({ error: "Este link ya fue usado." }, { status: 409 });
  }

  return jsonResponse({ ok: true });
}
