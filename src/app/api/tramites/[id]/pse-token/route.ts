import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma as db } from "@/lib/db/prisma";
import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { solicitarCodigoPse } from "@/lib/whatsapp/pse-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Contexto del pago que viaja en el WhatsApp. Todo opcional: sin él, el aviso sale igual. */
const bodySchema = z
  .object({
    valor: z.string().regex(/^\d{1,15}$/, "Valor en COP enteros").optional(),
    beneficiario: z.string().trim().max(120).optional(),
    concepto: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * POST /api/tramites/[id]/pse-token
 * Crea la solicitud del código del token PSE y avisa por WhatsApp (Kapso) a los
 * aprobadores de WHATSAPP_APROBADORES_PSE. Si el WhatsApp no sale, la solicitud
 * igual queda creada y se devuelve el enlace para mandarlo a mano.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  const raw: unknown = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos del pago inválidos." }, { status: 400 });
  }

  const tramite = await db.tramiteDO.findUnique({
    where: { id },
    select: { id: true, consecutivo: true },
  });
  if (!tramite) {
    return NextResponse.json({ error: "Trámite no encontrado." }, { status: 404 });
  }

  const resultado = await solicitarCodigoPse({
    tramiteId: tramite.id,
    consecutivo: tramite.consecutivo,
    usuarioId: session.user.id,
    operador: session.user.name,
    valor: parsed.data.valor ? BigInt(parsed.data.valor) : null,
    beneficiario: parsed.data.beneficiario || null,
    concepto: parsed.data.concepto || null,
  });

  return jsonResponse({ ok: true, ...resultado });
}
