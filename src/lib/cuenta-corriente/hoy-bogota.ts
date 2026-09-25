/**
 * "AAAA-MM-DD" de hoy en hora de Colombia. NUNCA `toISOString()` (UTC): después
 * de las 19:00 en Colombia ya es el día siguiente en UTC y los formularios
 * proponían la fecha de mañana.
 */
export function hoyBogota(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(ahora);
}
