import type { KapsoConfig } from "./config";

/**
 * Envío por el proxy de Meta que expone Kapso:
 *   POST {baseUrl}/{phone_number_id}/messages   header X-API-Key   cuerpo Cloud API
 *
 * SIN reintentos a propósito: el envío de Kapso no es idempotente y reintentar
 * tras un timeout puede duplicar el WhatsApp (advertencia de 2brain). Si falla,
 * se registra el fallo y el operario ve el enlace para copiarlo a mano.
 *
 * Los errores llevan solo códigos (KAPSO_HTTP_400_131047): terminan en la BD y
 * el mensaje de Meta puede repetir el teléfono del destinatario.
 */
export class KapsoEnvioError extends Error {
  constructor(public readonly codigo: string) {
    super(codigo);
    this.name = "KapsoEnvioError";
  }
}

export interface CuerpoCloudApi {
  messaging_product: string;
  to: string;
  type: string;
  [clave: string]: unknown;
}

/** Header de la pasarela de Sixteam: durante N segundos, una respuesta SIN cita de esa
 *  persona vuelve a Galcomex (afinidad). Kapso directo lo ignora. */
export const HEADER_ESPERA_RESPUESTA = "X-Gateway-Espera-Respuesta";

export interface OpcionesEnvio {
  esperaRespuestaSegundos?: number;
  fetchImpl?: typeof fetch;
}

export async function enviarWhatsapp(
  config: KapsoConfig,
  cuerpo: CuerpoCloudApi,
  opciones: OpcionesEnvio = {},
): Promise<{ wamid: string }> {
  const fetchImpl = opciones.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", "X-API-Key": config.apiKey };
  if (opciones.esperaRespuestaSegundos) headers[HEADER_ESPERA_RESPUESTA] = String(opciones.esperaRespuestaSegundos);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let respuesta: Response;
  try {
    respuesta = await fetchImpl(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(cuerpo),
      signal: controller.signal,
    });
  } catch (error) {
    throw new KapsoEnvioError(error instanceof Error && error.name === "AbortError" ? "KAPSO_TIMEOUT" : "KAPSO_RED");
  } finally {
    clearTimeout(timeout);
  }

  const json = (await respuesta.json().catch(() => null)) as {
    messages?: Array<{ id?: unknown }>;
    error?: { code?: unknown };
  } | null;

  if (!respuesta.ok) {
    const codigoMeta = typeof json?.error?.code === "number" ? `_${json.error.code}` : "";
    throw new KapsoEnvioError(`KAPSO_HTTP_${respuesta.status}${codigoMeta}`);
  }
  const wamid = json?.messages?.[0]?.id;
  if (typeof wamid !== "string" || wamid === "") throw new KapsoEnvioError("KAPSO_SIN_WAMID");
  return { wamid };
}
