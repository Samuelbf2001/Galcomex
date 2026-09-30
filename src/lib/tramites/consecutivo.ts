/**
 * Consecutivos de trámite — Galcomex (M4)
 *
 * FUNCIONES PURAS, SIN BD. El formato y el alcance del contador salen de la
 * configuración del `TipoTramite`, no de un `if` por tipo de cliente ni de un
 * string quemado en el servicio.
 *
 * Formatos que produce hoy el catálogo:
 *   IMPORTACION   → `DO.BAQ26-0001`  (contador por ciudad y año; BAQ, BGT y BUN
 *                                      comparten UN contador, 30-sep-2026)
 *   EXPORTACION   → `DO.EXP26-0013`  (contador por año, sin ciudad)
 *   CLASIFICACION → `CLAS26-0001`    (contador por año, sin ciudad)
 *   GLOBAL        → `PV-0001`        (un solo contador histórico)
 *
 * Numeración como Camila (decisión de Ernesto, 30-sep-2026): con
 * `ciudadesContadorComun` varias ciudades comparten un solo contador (el
 * siguiente es el máximo de las tres + 1) y el número se sigue imprimiendo con
 * la ciudad del DO. Un piso (`consecutivo_piso`) puede subir el punto de
 * partida de un contador: siguiente = max(último, piso) + 1. El servicio del DO
 * nunca entra en el contador.
 */

export type SecuenciaTramite = "CIUDAD_ANIO" | "ANIO" | "GLOBAL";

export interface ConfigConsecutivo {
  prefijoConsecutivo: string;
  secuenciaPor: SecuenciaTramite;
  incluyeCiudadEnConsecutivo: boolean;
  /**
   * Solo con `CIUDAD_ANIO`: ciudades que comparten UN solo contador. Una
   * ciudad fuera de la lista lleva el suyo. Ausente o vacío = un contador por
   * ciudad (como antes del 30-sep-2026).
   */
  ciudadesContadorComun?: readonly string[];
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

/** Alcance de UN contador: qué DOs cuentan para el siguiente número. */
export interface AlcanceContador<C extends string = string> {
  /**
   * Nombre del contador: `IMPORTACION:BAQ+BGT+BUN:2026`, `IMPORTACION:CTG:2026`,
   * `EXPORTACION:2026`, `PLAN_VALLEJO`. Es la clave de `consecutivo_piso`.
   */
  clave: string;
  /** Clave del advisory lock: `tramite-do:{clave}`. */
  claveLock: string;
  /**
   * Ciudades que cuentan (ordenadas). `null` = cualquier ciudad (contador por
   * año o global). Una sola ciudad = contador propio de esa ciudad.
   */
  ciudades: C[] | null;
  /** Año del contador; `null` en un contador global. */
  anio: number | null;
}

/**
 * Alcance del contador de un DO de este tipo, ciudad y año. Todas las ciudades
 * de `ciudadesContadorComun` dan la MISMA clave (ciudades en orden alfabético,
 * unidas con `+`), así toman el mismo candado y ven el mismo máximo. Una
 * ciudad sola, un contador por año y uno global dan exactamente la misma clave
 * de candado que antes del 30-sep-2026.
 */
export function alcanceContador<C extends string>(
  config: ConfigConsecutivo,
  tipoTramiteCodigo: string,
  ciudad: C,
  anio: number,
): AlcanceContador<C> {
  switch (config.secuenciaPor) {
    case "CIUDAD_ANIO": {
      const comunes = config.ciudadesContadorComun ?? [];
      const ciudades = (comunes.includes(ciudad) ? [...new Set(comunes)].sort() : [ciudad]) as C[];
      const clave = `${tipoTramiteCodigo}:${ciudades.join("+")}:${anio}`;
      return { clave, claveLock: `tramite-do:${clave}`, ciudades, anio };
    }
    case "ANIO": {
      const clave = `${tipoTramiteCodigo}:${anio}`;
      return { clave, claveLock: `tramite-do:${clave}`, ciudades: null, anio };
    }
    case "GLOBAL": {
      const clave = tipoTramiteCodigo;
      return { clave, claveLock: `tramite-do:${clave}`, ciudades: null, anio: null };
    }
  }
}

/**
 * Filtro Prisma de un alcance: una ciudad → `ciudad: C`; varias →
 * `ciudad: { in: [...] }`; ninguna → sin filtro de ciudad.
 */
export function filtroDeAlcance<C extends string>(
  tipoTramiteCodigo: string,
  alcance: AlcanceContador<C>,
): { tipoTramiteCodigo: string; ciudad?: C | { in: C[] }; anio?: number } {
  const filtro: { tipoTramiteCodigo: string; ciudad?: C | { in: C[] }; anio?: number } = {
    tipoTramiteCodigo,
  };
  if (alcance.ciudades) {
    filtro.ciudad = alcance.ciudades.length === 1 ? alcance.ciudades[0] : { in: alcance.ciudades };
  }
  if (alcance.anio !== null) {
    filtro.anio = alcance.anio;
  }
  return filtro;
}

/** Siguiente número: `max(último ?? 0, piso ?? 0) + 1`. */
export function siguienteNumero(ultimo: number | null | undefined, piso: number | null | undefined): number {
  return Math.max(ultimo ?? 0, piso ?? 0) + 1;
}

/**
 * Error de configuración del contador (`null` si está bien): las ciudades
 * comunes solo tienen sentido con `CIUDAD_ANIO` y no se pueden repetir.
 */
export function validarConfigContador(config: ConfigConsecutivo): string | null {
  const comunes = config.ciudadesContadorComun ?? [];
  if (comunes.length === 0) return null;
  if (config.secuenciaPor !== "CIUDAD_ANIO") {
    return "Las ciudades con contador compartido solo aplican a un contador por ciudad y año.";
  }
  if (new Set(comunes).size !== comunes.length) {
    return "Hay ciudades repetidas en el contador compartido.";
  }
  return null;
}

/**
 * Clave del advisory lock. Tiene que cubrir EXACTAMENTE el mismo alcance que
 * `filtroSecuencia`: si el lock es más ancho se serializa de más, y si es más
 * angosto dos trámites pueden tomar el mismo número. Delega en `alcanceContador`.
 */
export function claveSecuencia(
  config: ConfigConsecutivo,
  tipoTramiteCodigo: string,
  ciudad: string,
  anio: number,
): string {
  return alcanceContador(config, tipoTramiteCodigo, ciudad, anio).claveLock;
}

/**
 * Filtro Prisma que delimita el contador. Mismo alcance que `claveSecuencia`.
 * Genérico en `ciudad` para conservar el tipo del enum `Ciudad` de Prisma.
 * Con ciudades comunes, `ciudad` es `{ in: [...] }`.
 */
export function filtroSecuencia<C extends string>(
  config: ConfigConsecutivo,
  tipoTramiteCodigo: string,
  ciudad: C,
  anio: number,
): { tipoTramiteCodigo: string; ciudad?: C | { in: C[] }; anio?: number } {
  return filtroDeAlcance(tipoTramiteCodigo, alcanceContador(config, tipoTramiteCodigo, ciudad, anio));
}

/** Etiqueta del contador para la pantalla: «contador compartido Barranquilla, Bogotá y Buenaventura». */
export function etiquetaContador(
  alcance: Pick<AlcanceContador, "ciudades">,
  nombreCiudad: (ciudad: string) => string,
  nombreTipo: string,
): string {
  if (!alcance.ciudades) return `contador de ${nombreTipo.toLowerCase()}`;
  const nombres = alcance.ciudades.map(nombreCiudad);
  if (nombres.length === 1) return `contador de ${nombres[0]}`;
  const lista = `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
  return `contador compartido ${lista}`;
}
