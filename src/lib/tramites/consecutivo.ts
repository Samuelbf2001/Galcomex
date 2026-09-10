/**
 * Consecutivos de trámite — Galcomex (M4)
 *
 * FUNCIONES PURAS, SIN BD. El formato y el alcance del contador salen de la
 * configuración del `TipoTramite`, no de un `if` por tipo de cliente ni de un
 * string quemado en el servicio.
 *
 * Formatos que produce hoy el catálogo:
 *   IMPORTACION   → `DO.BAQ26-0001`  (contador por ciudad y año)
 *   CLASIFICACION → `CLAS26-0001`    (contador por año, sin ciudad)
 *   GLOBAL        → `PV-0001`        (un solo contador histórico)
 */

export type SecuenciaTramite = "CIUDAD_ANIO" | "ANIO" | "GLOBAL";

export interface ConfigConsecutivo {
  prefijoConsecutivo: string;
  secuenciaPor: SecuenciaTramite;
  incluyeCiudadEnConsecutivo: boolean;
}

/**
 * Consecutivo impreso. `numero` se rellena a 4 dígitos pero no se trunca:
 * el DO 12.345 sale como `DO.BAQ26-12345`, nunca como `DO.BAQ26-2345`.
 */
export function formatConsecutivo(
  config: ConfigConsecutivo,
  ciudad: string,
  anio: number,
  numero: number,
): string {
  const secuencial = String(numero).padStart(4, "0");

  if (config.secuenciaPor === "GLOBAL") {
    return `${config.prefijoConsecutivo}-${secuencial}`;
  }

  const anioCorto = String(anio).slice(-2);

  if (config.incluyeCiudadEnConsecutivo) {
    return `${config.prefijoConsecutivo}.${ciudad}${anioCorto}-${secuencial}`;
  }

  return `${config.prefijoConsecutivo}${anioCorto}-${secuencial}`;
}

/**
 * Clave del advisory lock. Tiene que cubrir EXACTAMENTE el mismo alcance que
 * `filtroSecuencia`: si el lock es más ancho se serializa de más, y si es más
 * angosto dos trámites pueden tomar el mismo número.
 */
export function claveSecuencia(
  config: ConfigConsecutivo,
  tipoTramiteCodigo: string,
  ciudad: string,
  anio: number,
): string {
  switch (config.secuenciaPor) {
    case "CIUDAD_ANIO":
      return `tramite-do:${tipoTramiteCodigo}:${ciudad}:${anio}`;
    case "ANIO":
      return `tramite-do:${tipoTramiteCodigo}:${anio}`;
    case "GLOBAL":
      return `tramite-do:${tipoTramiteCodigo}`;
  }
}

/**
 * Filtro Prisma que delimita el contador. Mismo alcance que `claveSecuencia`.
 * Genérico en `ciudad` para conservar el tipo del enum `Ciudad` de Prisma.
 */
export function filtroSecuencia<C extends string>(
  config: ConfigConsecutivo,
  tipoTramiteCodigo: string,
  ciudad: C,
  anio: number,
): { tipoTramiteCodigo: string; ciudad?: C; anio?: number } {
  switch (config.secuenciaPor) {
    case "CIUDAD_ANIO":
      return { tipoTramiteCodigo, ciudad, anio };
    case "ANIO":
      return { tipoTramiteCodigo, anio };
    case "GLOBAL":
      return { tipoTramiteCodigo };
  }
}
