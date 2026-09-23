/**
 * Fecha de calendario en Bogotá — F5 (revisión de Ernesto, 22-sep-2026).
 *
 * `vigenteEn` (`lib/tarifas/motor.ts`) compara un instante contra
 * `vigenteHasta` a las 23:59:59.999 **UTC**, y sus llamadores le pasaban
 * `new Date()` (el instante UTC "ahora"). Colombia es UTC−5 todo el año (sin
 * horario de verano), así que una tarifa dejaba de contar 5 horas antes de
 * medianoche en Bogotá (19:00) el último día de vigencia, y una nueva
 * empezaba a regir 5 horas antes de lo debido. Esta función NO toca
 * `vigenteEn`: da el "hoy" correcto (medianoche UTC del día calendario en
 * Bogotá) para pasarle en su lugar.
 *
 * Sin dependencias de Node ni de BD — se usa tanto en servidor
 * (`tarifas/service.ts`, `tramites/requisitos.ts`) como en el navegador
 * (`components/clientes/clientes-api.ts`).
 */
const OFFSET_BOGOTA_MS = 5 * 60 * 60 * 1000;

/**
 * Día calendario en Bogotá de un instante, como medianoche UTC — el mismo
 * formato con el que se guardan `vigenteDesde`/`vigenteHasta`. Por defecto,
 * el día calendario de "ahora".
 */
export function fechaCalendarioBogota(ahora: Date = new Date()): Date {
  const enBogota = new Date(ahora.getTime() - OFFSET_BOGOTA_MS);
  return new Date(
    Date.UTC(enBogota.getUTCFullYear(), enBogota.getUTCMonth(), enBogota.getUTCDate()),
  );
}
