import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Kapso firma cada entrega con `X-Webhook-Signature`: HMAC-SHA256 en HEX del
 * cuerpo CRUDO con el secret_key del webhook (docs.kapso.ai → webhooks/security).
 * Se verifica sobre los bytes tal como llegaron, nunca sobre un JSON re-serializado.
 *
 * Lección de Mizar (2026-09-11): leer otro nombre de cabecera dejó todo en 401
 * silencioso y Kapso terminó pausando el webhook. Aquí se acepta solo la
 * cabecera documentada, con o sin prefijo "sha256=".
 */
export function verificarFirmaKapso(cuerpoCrudo: string, firma: string | null, secreto: string): boolean {
  if (!firma || !secreto) return false;
  const recibida = firma.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recibida)) return false;
  const esperada = createHmac("sha256", secreto).update(cuerpoCrudo, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(recibida, "hex"), Buffer.from(esperada, "hex"));
}

/** Comparación en tiempo constante para el segundo cerrojo (header fijo). */
export function igualSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
