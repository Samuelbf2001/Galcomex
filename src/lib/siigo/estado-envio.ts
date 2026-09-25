/**
 * Estado del envío de un borrador a Siigo — reglas PURAS (sin BD ni red), las
 * usan el servidor y la UI.
 *
 * Una factura, un solo POST a Siigo. El envío primero reclama el borrador
 * (null | ERROR → ENVIANDO) y solo entonces llama a Siigo; el resultado queda en
 * `siigoEnvioEstado`:
 *
 * - ENVIANDO: la llamada está en curso. Si lleva más de 10 minutos (el proceso
 *   murió a mitad de camino) se trata como INCIERTO. Nunca se reintenta solo.
 * - ENVIADO: Siigo devolvió el id y quedó en `siigoDraftId`.
 * - INCIERTO: no sabemos si Siigo creó la factura (timeout, error de red, 5xx,
 *   respuesta 2xx inválida o fallo de la BD tras un 2xx). Reintentar está
 *   BLOQUEADO hasta que un ADMIN revise en Siigo.
 * - ERROR: Siigo la rechazó sin crearla (4xx de validación) o la llamada nunca
 *   salió (credenciales, token). Se puede reintentar.
 */

export type SiigoEnvioEstadoValor = "ENVIANDO" | "ENVIADO" | "INCIERTO" | "ERROR";

/** A partir de aquí un ENVIANDO se considera colgado y se presenta como INCIERTO. */
export const MINUTOS_ENVIANDO_COLGADO = 10;
const MS_ENVIANDO_COLGADO = MINUTOS_ENVIANDO_COLGADO * 60_000;

export type DatosEstadoEnvio = {
  siigoEnvioEstado: SiigoEnvioEstadoValor | null;
  siigoEnvioIniciadoAt: Date | string | null;
};

/** Momento a partir del cual un ENVIANDO iniciado antes cuenta como colgado. */
export function limiteEnviandoColgado(ahora: Date): Date {
  return new Date(ahora.getTime() - MS_ENVIANDO_COLGADO);
}

/**
 * Estado que se muestra y con el que se decide: igual al guardado, salvo un
 * ENVIANDO de más de 10 minutos (o sin fecha de inicio), que es INCIERTO.
 */
export function estadoEnvioEfectivo(
  datos: DatosEstadoEnvio,
  ahora: Date = new Date(),
): SiigoEnvioEstadoValor | null {
  if (datos.siigoEnvioEstado !== "ENVIANDO") return datos.siigoEnvioEstado;
  if (!datos.siigoEnvioIniciadoAt) return "INCIERTO";
  const inicio = new Date(datos.siigoEnvioIniciadoAt).getTime();
  if (Number.isNaN(inicio)) return "INCIERTO";
  return ahora.getTime() - inicio > MS_ENVIANDO_COLGADO ? "INCIERTO" : "ENVIANDO";
}

/** ¿Se puede (re)intentar el envío? Solo sin id de Siigo y sin envío previo, o tras un rechazo. */
export function puedeEnviarASiigo(
  datos: DatosEstadoEnvio & { siigoDraftId: string | null },
): boolean {
  if (datos.siigoDraftId) return false;
  return datos.siigoEnvioEstado === null || datos.siigoEnvioEstado === "ERROR";
}

export const ETIQUETA_ESTADO_ENVIO: Record<SiigoEnvioEstadoValor, string> = {
  ENVIANDO: "Enviando a SIIGO…",
  ENVIADO: "Borrador en SIIGO",
  INCIERTO: "Envío sin confirmar: revisar en SIIGO",
  ERROR: "SIIGO rechazó el envío: se puede reintentar",
};

export const DESCRIPCION_ESTADO_ENVIO: Record<SiigoEnvioEstadoValor, string> = {
  ENVIANDO: "La factura se está enviando a SIIGO. Espera unos segundos y recarga.",
  ENVIADO: "SIIGO creó la factura como borrador y Galcomex guardó su identificador.",
  INCIERTO:
    "No sabemos si SIIGO alcanzó a crear la factura. No se puede reenviar hasta que un ADMIN la revise en SIIGO.",
  ERROR: "SIIGO rechazó la factura sin crearla. Corrige lo indicado y vuelve a enviarla.",
};

/** Mensaje base del 409 cuando el reclamo del envío no procede. */
export const MENSAJE_ENVIO_BLOQUEADO = "Esta factura ya se envió o se está enviando a SIIGO";

/** Detalle del 409 según el estado actual, para que el usuario sepa qué hacer. */
export function detalleEnvioBloqueado(
  datos: DatosEstadoEnvio & { siigoDraftId: string | null },
  ahora: Date = new Date(),
): string {
  const efectivo = estadoEnvioEfectivo(datos, ahora);
  if (datos.siigoDraftId) {
    return efectivo === "INCIERTO"
      ? `${MENSAJE_ENVIO_BLOQUEADO} (borrador ${datos.siigoDraftId}, sin confirmar). Un ADMIN debe usar «Revisar en SIIGO».`
      : `${MENSAJE_ENVIO_BLOQUEADO} (borrador ${datos.siigoDraftId}). Si hay que corregirla, hazlo en el portal de SIIGO.`;
  }
  if (efectivo === "ENVIANDO") {
    return `${MENSAJE_ENVIO_BLOQUEADO}: hay un envío en curso. Espera unos segundos y recarga la página.`;
  }
  if (efectivo === "INCIERTO") {
    return `${MENSAJE_ENVIO_BLOQUEADO}: el último envío quedó sin confirmar. Un ADMIN debe usar «Revisar en SIIGO» antes de reenviarla.`;
  }
  return `${MENSAJE_ENVIO_BLOQUEADO}. Recarga la página.`;
}
