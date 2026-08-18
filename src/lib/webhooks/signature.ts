/**
 * Firma HMAC-SHA256 de webhooks salientes — Galcomex.
 *
 * Función PURA: sin BD, sin red. Firma (y verifica) el cuerpo de un evento
 * con el secreto compartido `WEBHOOK_SECRET`, siguiendo el mismo patrón que
 * Stripe usa para sus webhooks:
 *
 *   1. Se firma `"<timestamp_unix_segundos>.<body>"` (no solo el body) para
 *      que la firma quede atada a un instante — así un atacante que
 *      intercepte un payload firmado no puede reproducirlo (replay) más
 *      tarde con la misma firma.
 *   2. La firma viaja en la cabecera `X-Galcomex-Signature` con el esquema
 *      `sha256=<hex>` (el prefijo identifica el algoritmo, útil si en el
 *      futuro se rota a otro sin romper consumidores que ya parsean el
 *      esquema).
 *   3. El timestamp viaja en su propia cabecera, `X-Galcomex-Timestamp`
 *      (unix segundos, string), en vez de empaquetado dentro de
 *      `X-Galcomex-Signature` — así el consumidor no necesita parsear un
 *      formato compuesto para poder rechazar por ventana de replay.
 *
 * `verificarFirma` es la contraparte que cualquier consumidor (n8n incluido)
 * necesita para validar un webhook entrante, y es lo que hace esto
 * trivialmente testeable sin levantar red. Usa `timingSafeEqual` — nunca
 * `===` — para que el tiempo de comparación no filtre por cuántos bytes
 * iniciales coinciden (ataque de timing).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Cabecera donde viaja la firma, esquema `sha256=<hex>`. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Galcomex-Signature";

/** Cabecera donde viaja el timestamp (unix segundos, string) usado en la firma. */
export const WEBHOOK_TIMESTAMP_HEADER = "X-Galcomex-Timestamp";

/** Prefijo de esquema dentro de `X-Galcomex-Signature`. */
const SIGNATURE_SCHEME_PREFIX = "sha256=";

/** Ventana de tolerancia por defecto para aceptar un timestamp (mitiga replay). */
export const WEBHOOK_TOLERANCIA_SEGUNDOS_DEFAULT = 300; // 5 minutos

export type FirmaWebhook = {
  /** Unix segundos (string) — mismo valor que se envía en X-Galcomex-Timestamp. */
  timestamp: string;
  /** `sha256=<hex>` — mismo valor que se envía en X-Galcomex-Signature. */
  firma: string;
};

/**
 * Firma `body` (el JSON ya serializado del evento) con HMAC-SHA256 usando
 * `secreto`. Firma el mensaje `"<timestamp>.<body>"`, no solo `body`.
 *
 * @param body      Cuerpo exacto (string) que se va a enviar por HTTP. Debe
 *                   firmarse el string final, no el objeto — cualquier
 *                   re-serialización (orden de llaves, espacios) rompería
 *                   la firma en el consumidor.
 * @param secreto   Valor de `WEBHOOK_SECRET`. Lanza si viene vacío — firmar
 *                   con secreto vacío no es un estado válido, es un bug de
 *                   configuración que debe fallar ruidosamente en quien firma
 *                   (a diferencia del dispatcher, que si no hay secreto
 *                   configurado hace no-op silencioso para no tumbar la
 *                   operación de negocio).
 * @param timestamp Instante a firmar (inyectable para tests). Default: ahora.
 */
export function firmarPayload(
  body: string,
  secreto: string,
  timestamp: Date = new Date(),
): FirmaWebhook {
  if (!secreto) {
    throw new Error("firmarPayload: WEBHOOK_SECRET vacío — no se puede firmar el payload");
  }

  const timestampSegundos = Math.floor(timestamp.getTime() / 1000).toString();
  const mensaje = `${timestampSegundos}.${body}`;
  const hex = createHmac("sha256", secreto).update(mensaje, "utf8").digest("hex");

  return { timestamp: timestampSegundos, firma: `${SIGNATURE_SCHEME_PREFIX}${hex}` };
}

export type VerificarFirmaInput = {
  /** Cuerpo exacto (string, tal como llegó en el request) a validar. */
  body: string;
  /** Valor recibido en la cabecera X-Galcomex-Timestamp. */
  timestamp: string;
  /** Valor recibido en la cabecera X-Galcomex-Signature (`sha256=<hex>`). */
  firma: string;
  /** Secreto compartido (`WEBHOOK_SECRET`). */
  secreto: string;
  /** Ventana de tolerancia en segundos. Default 300 (5 min). */
  toleranciaSegundos?: number;
  /** Instante de referencia para "ahora" (inyectable para tests). */
  ahora?: Date;
};

/**
 * Verifica que `firma` corresponda a HMAC-SHA256(`timestamp.body`, secreto)
 * y que `timestamp` esté dentro de la ventana de tolerancia respecto a
 * `ahora`. Rechaza (retorna `false`) sin lanzar ante cualquier entrada
 * malformada — un consumidor de webhooks no debe poder tumbar el proceso
 * verificador con un header inválido.
 *
 * Comparación en tiempo constante: nunca compara `firma` recibida contra la
 * esperada con `===`/`.length` variable-time. El único chequeo de longitud
 * que existe es el que exige `timingSafeEqual` (lanza si los buffers no
 * tienen el mismo tamaño) — como el tamaño de una firma `sha256=<hex>` es
 * siempre el mismo (72 caracteres) y no es secreto, revelar que una firma
 * "tiene el tamaño equivocado" no filtra ningún byte del HMAC real.
 */
export function verificarFirma(input: VerificarFirmaInput): boolean {
  const {
    body,
    timestamp,
    firma,
    secreto,
    toleranciaSegundos = WEBHOOK_TOLERANCIA_SEGUNDOS_DEFAULT,
    ahora = new Date(),
  } = input;

  if (!secreto || !timestamp || !firma) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) return false;

  const deltaSegundos = Math.abs(ahora.getTime() - timestampMs) / 1000;
  if (deltaSegundos > toleranciaSegundos) return false;

  let esperado: string;
  try {
    esperado = firmarPayload(body, secreto, new Date(timestampMs)).firma;
  } catch {
    return false;
  }

  const bufferEsperado = Buffer.from(esperado, "utf8");
  const bufferRecibido = Buffer.from(firma, "utf8");

  // timingSafeEqual exige buffers del mismo largo — sin esto lanzaría en vez
  // de retornar false. No es un atajo por contenido, solo por tamaño fijo.
  if (bufferEsperado.length !== bufferRecibido.length) return false;

  return timingSafeEqual(bufferEsperado, bufferRecibido);
}
