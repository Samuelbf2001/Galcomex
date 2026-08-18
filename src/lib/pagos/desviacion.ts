/**
 * Desviación entre el valor de un pago y la suma de las facturas de proveedor
 * vinculadas — reunión 1-jul-2026 (00:10:17): "si por ejemplo las facturas son
 * de 100.000 y estoy tratando de pagar 150.000, pues me alerta".
 *
 * Función PURA, sin BD — usada tanto por el servicio (validación server-side,
 * bloqueante) como por el cliente (diálogo de confirmación, UX). Cálculo en
 * BigInt: el dinero nunca pasa por flotantes; el resultado es un porcentaje
 * (número JS) solo para comparar contra el umbral configurado, nunca para
 * operaciones contables.
 */

/**
 * Desviación porcentual: (valor − sumaFacturas) / sumaFacturas × 100,
 * truncada a una décima. Replica exactamente el cálculo que ya usaba el
 * cliente: `Number((diff * 1000n) / sumaFacturas) / 10`.
 *
 * Sin base de comparación (sumaFacturas <= 0) devuelve 0.
 */
/**
 * Fallback de UI para el umbral de desviación cuando el caller no tiene el
 * valor real cargado (ej. un acceso directo que abre el modal sin pasar por
 * el libro de pagos). Espeja `DEFAULTS_UMBRAL.desviacionPagoPct` en
 * `src/lib/parametros/service.ts` — el servidor SIEMPRE re-valida contra el
 * parámetro real, así que este número solo afecta cuándo aparece el diálogo
 * de confirmación en el cliente, nunca si el pago se acepta o no.
 */
export const DEFAULT_UMBRAL_DESVIACION_PAGO_PCT = 10;

export function calcularDesviacionPct(valor: bigint, sumaFacturas: bigint): number {
  if (sumaFacturas <= 0n) return 0;
  const diff = valor - sumaFacturas;
  return Number((diff * 1000n) / sumaFacturas) / 10;
}

/**
 * true si |desviación| > umbralPct. Sin base de comparación (sumaFacturas <= 0)
 * nunca excede — no hay nada contra qué comparar.
 */
export function excedeUmbralDesviacion(
  valor: bigint,
  sumaFacturas: bigint,
  umbralPct: number,
): boolean {
  if (sumaFacturas <= 0n) return false;
  return Math.abs(calcularDesviacionPct(valor, sumaFacturas)) > umbralPct;
}
