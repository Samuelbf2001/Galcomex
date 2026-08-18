/**
 * Envío de webhooks salientes — Galcomex.
 *
 * Dos capas:
 *   - `enviarWebhookFirmado`: primitiva genérica (URL + secreto + body ya
 *     serializado → firma y hace POST). La usa tanto `dispatchWebhookEvent`
 *     (los 5 eventos tipados de `types.ts`) como la ruta PSE
 *     (`src/app/api/tramites/[id]/pse-token/route.ts`), cuyo payload NO es
 *     uno de los eventos tipados pero igual necesita quedar firmado.
 *   - `dispatchWebhookEvent`: capa tipada para los eventos de `types.ts`.
 *
 * Regla dura: un webhook JAMÁS puede tumbar la operación de negocio que lo
 * dispara. Por eso ambas funciones son fire-and-forget seguras — atrapan
 * cualquier error (red, timeout, JSON, lo que sea) y devuelven un resultado
 * en vez de lanzar. El caller puede hacer `await` (para tests, o si quiere
 * loguear el resultado) o simplemente invocarlas sin `await` — nunca deja
 * una promesa rechazada sin capturar.
 */
import { firmarPayload, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "./signature";
import type { WebhookEvent, WebhookEventPayloadMap, WebhookEventType } from "./types";

/** Timeout por defecto de la petición saliente — nunca cuelga indefinidamente. */
const DEFAULT_TIMEOUT_MS = 5000;

export type WebhookSendResult =
  | { ok: true; status: number }
  | {
      ok: false;
      motivo: "sin_url" | "sin_secreto" | "error_red" | "http_error";
      status?: number;
      detalle?: string;
    };

export type EnviarWebhookFirmadoInput = {
  /** URL destino. `undefined`/vacío ⇒ no-op silencioso (con log). */
  url: string | undefined;
  /** Secreto para firmar (`WEBHOOK_SECRET`). Ausente ⇒ no se envía sin firmar. */
  secreto: string | undefined;
  /** Cuerpo ya serializado (string) — se firma y se envía tal cual. */
  body: string;
  /** Identificador para logs (ej. nombre del evento o "pse-token"). Nunca se loguea el secreto ni la firma completa. */
  etiqueta: string;
  timeoutMs?: number;
};

/**
 * Primitiva de envío: firma `body` y hace POST a `url`. Nunca lanza.
 *
 * - Sin `url` configurada → no-op silencioso para el negocio, pero deja
 *   rastro en log (`console.warn`) para que quede claro por qué no salió
 *   nada — evita el "¿por qué n8n nunca recibió esto?" en producción.
 * - Sin `secreto` configurado → tampoco se envía (no hay forma de firmar).
 *   Se loguea como error porque, a diferencia de la URL, el secreto SÍ debe
 *   estar configurado en cualquier ambiente donde la URL también lo esté.
 */
export async function enviarWebhookFirmado(
  input: EnviarWebhookFirmadoInput,
): Promise<WebhookSendResult> {
  const { url, secreto, body, etiqueta, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  if (!url) {
    console.warn(`[webhooks] '${etiqueta}': URL no configurada — no-op (nada se envía)`);
    return { ok: false, motivo: "sin_url" };
  }

  if (!secreto) {
    console.error(`[webhooks] '${etiqueta}': WEBHOOK_SECRET no configurado — no se envía sin firmar`);
    return { ok: false, motivo: "sin_secreto" };
  }

  let firma: string;
  let timestamp: string;
  try {
    ({ firma, timestamp } = firmarPayload(body, secreto));
  } catch (error) {
    // firmarPayload solo lanza si el secreto viene vacío, ya descartado arriba,
    // pero por defensa en profundidad no dejamos que esto tumbe al caller.
    console.error(`[webhooks] '${etiqueta}': fallo al firmar —`, error instanceof Error ? error.message : error);
    return { ok: false, motivo: "sin_secreto" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: firma,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[webhooks] '${etiqueta}': respondió HTTP ${response.status}`);
      return { ok: false, motivo: "http_error", status: response.status };
    }

    return { ok: true, status: response.status };
  } catch (error) {
    console.error(
      `[webhooks] '${etiqueta}': fallo de red/timeout —`,
      error instanceof Error ? error.message : error,
    );
    return { ok: false, motivo: "error_red", detalle: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Construye y envía uno de los 5 eventos tipados de `types.ts`. Lee la URL
 * de `WEBHOOK_N8N_URL` (sin fallback hardcodeado) y el secreto de
 * `WEBHOOK_SECRET`. Fire-and-forget seguro — ver nota de cabecera del
 * archivo. NO se cablea en ningún servicio desde aquí; esto solo queda
 * listo para que el punto de emisión (creación de DO, aprobación de
 * factura, etc.) lo invoque.
 *
 * @example
 *   dispatchWebhookEvent("do.creado", { tramiteId, consecutivo, ... });
 */
export async function dispatchWebhookEvent<T extends WebhookEventType>(
  evento: T,
  data: WebhookEventPayloadMap[T],
  opts?: { timeoutMs?: number },
): Promise<WebhookSendResult> {
  const payload: WebhookEvent<T> = {
    evento,
    emitidoEn: new Date().toISOString(),
    data,
  };

  const body = JSON.stringify(payload);

  return enviarWebhookFirmado({
    url: process.env.WEBHOOK_N8N_URL,
    secreto: process.env.WEBHOOK_SECRET,
    body,
    etiqueta: evento,
    timeoutMs: opts?.timeoutMs,
  });
}
