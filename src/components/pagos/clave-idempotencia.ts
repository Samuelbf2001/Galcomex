/**
 * Clave de idempotencia de un formulario de pago (CxP v2, §B.5, CA-43).
 *
 * La pantalla la genera al abrir el formulario y la manda en cada envío: si la
 * respuesta se pierde (timeout del proxy) y la persona vuelve a pulsar
 * Guardar, el servidor devuelve el mismo pago (`repetido: true`) en vez de
 * registrar otro. Se renueva solo tras un guardado bueno o un 409
 * IDEMPOTENCIA_CONFLICTO. El servidor exige un UUID.
 */
export function nuevaClaveIdempotencia(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback muy defensivo (entornos sin Web Crypto); nunca debería usarse en el navegador real.
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
