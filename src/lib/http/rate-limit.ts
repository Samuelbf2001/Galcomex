/**
 * Rate limiting en memoria para intentos de login fallidos (hardening G2).
 *
 * Clave = `${ip}:${email}` (normalizado). Máximo `RATE_LIMIT_MAX_INTENTOS`
 * intentos fallidos por combinación IP+email dentro de una ventana de
 * `RATE_LIMIT_VENTANA_MS`. Un login exitoso limpia el contador de esa clave.
 *
 * Limitación conocida: el estado vive en memoria del proceso Node, por lo
 * que en un despliegue con varias instancias cada una lleva su propio
 * contador (no hay store compartido). Aceptable para el tamaño actual de
 * despliegue de Galcomex (instancia única). Si se escala horizontalmente,
 * migrar a un store compartido (Redis) manteniendo la misma interfaz.
 */

export const RATE_LIMIT_MAX_INTENTOS = 5;
export const RATE_LIMIT_VENTANA_MS = 15 * 60 * 1000; // 15 minutos

type EntradaLimite = {
  intentos: number;
  primerIntentoEn: number;
};

const intentosFallidos = new Map<string, EntradaLimite>();

/**
 * Construye la clave de rate limiting a partir de la IP y el email.
 * El email se normaliza (trim + minúsculas) para que variantes de
 * mayúsculas/espacios no evadan el contador.
 */
export function construirClaveLimite(ip: string, email: string): string {
  return `${ip}:${email.trim().toLowerCase()}`;
}

export type ResultadoLimite =
  | { bloqueado: false }
  | { bloqueado: true; segundosRestantes: number };

/**
 * Consulta si la clave está actualmente bloqueada por exceso de intentos
 * fallidos. No registra ningún intento nuevo; es una consulta pura.
 */
export function verificarLimite(clave: string): ResultadoLimite {
  const entrada = intentosFallidos.get(clave);
  if (!entrada) {
    return { bloqueado: false };
  }

  const transcurrido = Date.now() - entrada.primerIntentoEn;

  if (transcurrido >= RATE_LIMIT_VENTANA_MS) {
    // La ventana expiró: se limpia el contador y se permite el intento.
    intentosFallidos.delete(clave);
    return { bloqueado: false };
  }

  if (entrada.intentos >= RATE_LIMIT_MAX_INTENTOS) {
    const segundosRestantes = Math.max(
      1,
      Math.ceil((RATE_LIMIT_VENTANA_MS - transcurrido) / 1000),
    );
    return { bloqueado: true, segundosRestantes };
  }

  return { bloqueado: false };
}

/**
 * Registra un intento fallido de login para la clave (IP+email). Si no
 * existe una ventana activa (o la anterior expiró), inicia una nueva.
 */
export function registrarIntentoFallido(clave: string): void {
  const ahora = Date.now();
  const entrada = intentosFallidos.get(clave);

  if (!entrada || ahora - entrada.primerIntentoEn >= RATE_LIMIT_VENTANA_MS) {
    intentosFallidos.set(clave, { intentos: 1, primerIntentoEn: ahora });
    return;
  }

  entrada.intentos += 1;
}

/**
 * Limpia el contador de intentos fallidos de la clave. Se debe llamar tras
 * un login exitoso para no penalizar al usuario en su próximo intento.
 */
export function limpiarIntentos(clave: string): void {
  intentosFallidos.delete(clave);
}

/** Solo para tests: vacía todo el estado en memoria del rate limiter. */
export function resetRateLimitParaTests(): void {
  intentosFallidos.clear();
}
