/**
 * Autenticación de servicio-a-servicio para endpoints que n8n invoca en
 * agenda, sin sesión de navegador.
 *
 * `requireRole` exige una cookie de sesión (`getCurrentSession`), que no
 * existe cuando quien llama es un workflow programado de n8n, no una persona
 * con el navegador abierto. Sin esto, cualquier endpoint pensado para
 * agenda —como el que dispara `cartera.vencida`— sería, en la práctica,
 * imposible de automatizar: quedaría protegido para todos por igual, incluida
 * la automatización que necesita llamarlo.
 *
 * La solución es un secreto compartido en la cabecera `Authorization: Bearer
 * <secreto>`, comparado en tiempo constante (nunca `===`, que filtra por
 * cuántos bytes iniciales coinciden). Es el mismo patrón que "cron secret" en
 * Vercel/otras plataformas: no reemplaza el rol ADMIN, lo complementa — un
 * endpoint puede aceptar cualquiera de los dos caminos.
 */

import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/**
 * true si `Authorization` trae el secreto de servicio correcto para `clave`.
 * false si falta la cabecera, el secreto no está configurado, o no coincide.
 * Nunca lanza — un fallo de configuración debe traducirse en "no autorizado",
 * no en un 500.
 */
export function tieneTokenDeServicioValido(
  authorizationHeader: string | null,
  secretoEsperado: string | undefined,
): boolean {
  if (!secretoEsperado || !authorizationHeader) return false;
  if (!authorizationHeader.startsWith(BEARER_PREFIX)) return false;

  const recibido = authorizationHeader.slice(BEARER_PREFIX.length);
  const bufferEsperado = Buffer.from(secretoEsperado);
  const bufferRecibido = Buffer.from(recibido);

  // timingSafeEqual exige buffers del mismo largo — sin esto lanzaría en vez
  // de simplemente reportar "no coincide" ante un secreto de largo distinto.
  if (bufferEsperado.length !== bufferRecibido.length) return false;

  return timingSafeEqual(bufferEsperado, bufferRecibido);
}
