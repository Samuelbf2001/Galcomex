import { z } from "zod";

import { HEADER_TOKEN_WEBHOOK, kapsoConfig } from "@/lib/whatsapp/config";
import { igualSeguro, verificarFirmaKapso } from "@/lib/whatsapp/firma";
import { procesarWebhookKapso } from "@/lib/whatsapp/pse-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 100_000;
const cuerpoSchema = z.record(z.string(), z.unknown());

/** Lee como máximo `max` bytes: un content-length falso no debe llenar la memoria. */
async function leerAcotado(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      partes.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(partes).toString("utf8");
}

/**
 * POST /api/whatsapp/kapso — webhook de la línea de WhatsApp de Galcomex en Kapso.
 *
 * Público (lo llama Kapso), así que se defiende solo:
 *  1. Firma HMAC-SHA256 del cuerpo crudo (X-Webhook-Signature) con KAPSO_WEBHOOK_SECRET.
 *  2. Opcional: header fijo x-galcomex-token = KAPSO_WEBHOOK_TOKEN (Kapso lo reenvía).
 *  3. Descarta lo que venga de otra línea, de números que no son aprobadores y
 *     botones que no son "gx_" (ver src/lib/whatsapp/decidir.ts).
 *
 * Responde 200 aunque un mensaje se ignore: Kapso reintenta ante errores y, si
 * acumula fallos, PAUSA el webhook en silencio. Solo un fallo de BD devuelve 503
 * para que reintente.
 */
export async function POST(request: Request) {
  const config = kapsoConfig();
  if (!config) return Response.json({ error: "whatsapp_no_configurado" }, { status: 503 });

  const declarado = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declarado) && declarado > MAX_BYTES) {
    return Response.json({ error: "payload_grande" }, { status: 413 });
  }
  const crudo = await leerAcotado(request, MAX_BYTES);
  if (crudo === null) return Response.json({ error: "payload_invalido" }, { status: 413 });

  if (!verificarFirmaKapso(crudo, request.headers.get("x-webhook-signature"), config.webhookSecret)) {
    return Response.json({ error: "no_autorizado" }, { status: 401 });
  }
  if (config.webhookToken && !igualSeguro(request.headers.get(HEADER_TOKEN_WEBHOOK) ?? "", config.webhookToken)) {
    return Response.json({ error: "no_autorizado" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch {
    return Response.json({ error: "json_invalido" }, { status: 400 });
  }
  const parsed = cuerpoSchema.safeParse(json);
  if (!parsed.success) return Response.json({ received: true, eventos: 0 });

  try {
    const resultados = await procesarWebhookKapso(parsed.data, config);
    return Response.json({ received: true, eventos: resultados.length });
  } catch (error) {
    console.error("[whatsapp] webhook falló", error instanceof Error ? error.message : "");
    return Response.json({ error: "procesamiento" }, { status: 503 });
  }
}
