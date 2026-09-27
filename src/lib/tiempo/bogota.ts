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

// ─── Fechas-calendario (CxP v2, diseño §D.7 y regla R17) ─────────────────────
//
// Una fecha-calendario (fecha de factura, de pago, de TRM, de cruce) es un DÍA,
// no un instante. Se guarda como 00:00 UTC de ese día y se MUESTRA en UTC, así
// una factura del 10-sep sale 10/09/2026 en cualquier navegador (antes salía
// 09/09 porque se formateaba en la hora de Colombia). "Hoy" es el día
// calendario en Bogotá: después de las 19:00 ya no propone la fecha de mañana.
//
// Tolerancia a filas viejas: un valor con CUALQUIER hora distinta de
// 00:00:00.000 UTC no es una fecha-calendario sino un instante (p. ej. un
// `fechaEnviadoAFacturar` guardado con `new Date()` antes del 26-sep, o las
// facturas históricas cargadas a las 12:00 UTC) y se lee como el día en Bogotá
// de ese instante. Así esas filas muestran el día correcto sin migrar datos.

const RE_SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

function esMedianocheUtc(d: Date): boolean {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

function desdeYmd(texto: string): Date | null {
  const m = RE_SOLO_FECHA.exec(texto);
  if (!m) return null;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  // Rechaza fechas imposibles ("2026-02-30" no debe convertirse en 2-mar).
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return null;
  }
  return d;
}

/** "YYYY-MM-DD" del día calendario en Bogotá. A las 23:29 de Bogotá del 23-sep → "2026-09-23". */
export function hoyBogotaISO(ahora: Date = new Date()): string {
  return fechaCalendarioBogota(ahora).toISOString().slice(0, 10);
}

/**
 * Convierte lo que llega de un formulario o de la API a fecha-calendario
 * (00:00 UTC del día):
 *  - "2026-09-10"                → 2026-09-10T00:00:00.000Z
 *  - un instante a 00:00:00.000Z → se respeta (ya es fecha-calendario)
 *  - cualquier otro instante     → el día calendario en Bogotá de ese instante
 * Lanza `RangeError` si el texto no es una fecha válida.
 */
export function aFechaCalendario(v: string | Date): Date {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new RangeError("Fecha inválida");
    return esMedianocheUtc(v) ? new Date(v.getTime()) : fechaCalendarioBogota(v);
  }
  const texto = v.trim();
  const soloFecha = desdeYmd(texto);
  if (soloFecha) return soloFecha;
  if (RE_SOLO_FECHA.test(texto)) throw new RangeError(`Fecha inválida: "${v}"`);
  const instante = new Date(texto);
  if (Number.isNaN(instante.getTime())) throw new RangeError(`Fecha inválida: "${v}"`);
  return esMedianocheUtc(instante) ? instante : fechaCalendarioBogota(instante);
}

function aDate(v: string | Date): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const texto = v.trim();
  const soloFecha = desdeYmd(texto);
  if (soloFecha) return soloFecha;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * El día que representa `v`, como 00:00 UTC y sin lanzar: una fecha-calendario
 * (00:00:00.000 UTC) se respeta; cualquier otro instante → su día en Bogotá.
 * Inválida → null.
 */
function aDiaCalendario(v: string | Date): Date | null {
  const d = aDate(v);
  if (!d) return null;
  return esMedianocheUtc(d) ? d : fechaCalendarioBogota(d);
}

const FORMATO_CORTO = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const FORMATO_LARGO = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * Muestra una fecha-calendario: "10/09/2026" (corta) o
 * "10 de septiembre de 2026" (larga), igual en cualquier navegador.
 *  - a 00:00:00.000 UTC (fecha-calendario) → ese día en UTC:
 *    2026-09-10T00:00:00.000Z → "10/09/2026"
 *  - con cualquier otra hora (instante viejo) → su día en Bogotá:
 *    2026-09-21T01:00:00.000Z (20:00 del 20 en Bogotá) → "20/09/2026"
 * null o inválida → "".
 */
export function formatFechaCalendario(
  v: string | Date | null | undefined,
  estilo: "corta" | "larga" = "corta",
): string {
  if (v === null || v === undefined) return "";
  const d = aDiaCalendario(v);
  if (!d) return "";
  return (estilo === "larga" ? FORMATO_LARGO : FORMATO_CORTO).format(d);
}

/**
 * Valor para un `<input type="date">` (y para comparar o serializar días):
 * "YYYY-MM-DD" con la misma regla que `formatFechaCalendario` — 00:00 UTC →
 * ese día; otro instante → su día en Bogotá. null o inválida → "".
 */
export function fechaCalendarioAInput(v: string | Date | null | undefined): string {
  if (v === null || v === undefined) return "";
  const d = aDiaCalendario(v);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

const FORMATO_INSTANTE_BOGOTA = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/**
 * Día (en Bogotá) de un INSTANTE real — p. ej. cuándo se anuló un bloque
 * (`anuladoEn`) —, no de una fecha-calendario: "20/09/2026" para las 20:00 de
 * Bogotá del 20-sep (01:00Z del 21). Igual en cualquier navegador. null o
 * inválida → "".
 */
export function formatInstanteBogota(v: string | Date | null | undefined): string {
  if (v === null || v === undefined) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return FORMATO_INSTANTE_BOGOTA.format(d);
}
