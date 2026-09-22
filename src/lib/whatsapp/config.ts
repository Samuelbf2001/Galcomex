/**
 * Configuración del canal WhatsApp. Todo sale del entorno del servicio en
 * EasyPanel; ningún valor de secreto vive en el repo.
 *
 * En producción Galcomex NO habla con Kapso directo: usa la pasarela de Sixteam
 * (sixteam-whatsapp-gateway, wa.sixteam.pro), que comparte la línea Sixteam.pro
 * entre plataformas. La pasarela imita al proxy de Kapso, así que las variables
 * conservan el nombre KAPSO_* pero apuntan a ella:
 *
 * - KAPSO_META_PROXY_URL    https://wa.sixteam.pro/v1  (sin él, Kapso directo)
 * - KAPSO_API_KEY           GATEWAY_API_KEY que entrega el alta del inquilino galcomex
 * - KAPSO_PHONE_NUMBER_ID   1441307479057660 (línea Sixteam.pro). El webhook descarta otras líneas.
 * - KAPSO_WEBHOOK_SECRET    GATEWAY_WEBHOOK_SECRET: la pasarela firma sus reenvíos con él (HMAC-SHA256 hex).
 * - KAPSO_PLANTILLA_PSE     Opcional. Nombre de la plantilla aprobada (galcomex_codigo_pse).
 * - KAPSO_PLANTILLA_IDIOMA  Opcional. Código de idioma REAL con que Meta registró la plantilla
 *                           (en 2brain quedó "en" aunque el texto es español; verificar con el script).
 * - KAPSO_WEBHOOK_TOKEN     Opcional. Segundo cerrojo: Kapso reenvía headers fijos en cada entrega.
 */
export const PROXY_POR_DEFECTO = "https://api.kapso.ai/meta/whatsapp/v24.0";
export const PLANTILLA_PSE_POR_DEFECTO = "galcomex_codigo_pse";
export const HEADER_TOKEN_WEBHOOK = "x-galcomex-token";

export interface KapsoConfig {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string;
  baseUrl: string;
  plantillaPse: string;
  idiomaPlantilla: string;
  webhookToken: string | null;
  timeoutMs: number;
}

function leer(nombre: string): string {
  return process.env[nombre]?.trim() ?? "";
}

/** null cuando falta algo obligatorio: el canal queda apagado, nunca a medias. */
export function kapsoConfig(): KapsoConfig | null {
  const apiKey = leer("KAPSO_API_KEY");
  const phoneNumberId = leer("KAPSO_PHONE_NUMBER_ID");
  const webhookSecret = leer("KAPSO_WEBHOOK_SECRET");
  if (!apiKey || !phoneNumberId || !webhookSecret) return null;
  return {
    apiKey,
    phoneNumberId,
    webhookSecret,
    baseUrl: (leer("KAPSO_META_PROXY_URL") || PROXY_POR_DEFECTO).replace(/\/+$/, ""),
    plantillaPse: leer("KAPSO_PLANTILLA_PSE") || PLANTILLA_PSE_POR_DEFECTO,
    idiomaPlantilla: leer("KAPSO_PLANTILLA_IDIOMA") || "es",
    webhookToken: leer("KAPSO_WEBHOOK_TOKEN") || null,
    timeoutMs: Number(leer("KAPSO_SEND_TIMEOUT_MS")) || 8_000,
  };
}

/** URL pública de la app (para el botón "Abrir enlace" y el enlace de respaldo). */
export function urlPublicaApp(): string {
  return (leer("NEXT_PUBLIC_APP_URL") || "https://galcomex.sixteam.pro").replace(/\/+$/, "");
}
