/**
 * Consecutivos de trámite — Galcomex (M4)
 *
 * FUNCIONES PURAS, SIN BD. El formato y el alcance del contador salen de la
 * configuración del `TipoTramite`, no de un `if` por tipo de cliente ni de un
 * string quemado en el servicio.
 *
 * Formatos que produce hoy el catálogo:
 *   IMPORTACION   → `DO.BAQ26-0001`      (contador por ciudad y año; BAQ, BGT y BUN
 *                                          comparten UN contador, 30-sep-2026)
 *   EXPORTACION   → `DO.EXP26-0013`      (Barranquilla, Bogotá y Buenaventura: UN
 *                                          contador, el número no lleva ciudad)
 *                   `DO.EXP.CTG26-0001`  (Cartagena, contador propio; prefijo provisional)
 *                   `DO.EXP.SMR26-0001`  (Santa Marta, contador propio; prefijo provisional)
 *   CLASIFICACION → `CLAS26-0001`        (contador por año, sin ciudad)
 *   GLOBAL        → `PV-0001`            (un solo contador histórico)
 *
 * Numeración como Camila (decisión de Ernesto, 30-sep-2026): con
 * `ciudadesContadorComun` varias ciudades comparten un solo contador (el
 * siguiente es el máximo de las tres + 1) y el número se sigue imprimiendo con
 * la ciudad del DO. Un piso (`consecutivo_piso`) puede subir el punto de
 * partida de un contador: siguiente = max(último, piso) + 1. El servicio del DO
 * nunca entra en el contador.
 *
 * Exportación por ciudad (decisión de Ernesto confirmada por Camila,
 * 30-sep-2026): con `CIUDAD_ANIO`, `prefijoConsecutivoPorCiudad` le da a una
 * ciudad su propio prefijo (`{"CTG": "DO.EXP.CTG"}`); las demás usan
 * `prefijoConsecutivo`. Así un tipo cuyo número NO lleva la ciudad puede tener
 * varios contadores sin que dos de ellos impriman el mismo texto.
 * `validarConfigContador` (un tipo) y `problemasDeNumeracion` (todo el
 * catálogo) rechazan la configuración que lo permitiría.
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
  /**
   * Solo con `CIUDAD_ANIO`: prefijo propio de algunas ciudades, p. ej.
   * `{ "CTG": "DO.EXP.CTG", "SMR": "DO.EXP.SMR" }`. Una ciudad que no está en
   * el mapa usa `prefijoConsecutivo`. Es la columna Json
   * `tipo_tramite.prefijoConsecutivoPorCiudad` (por eso `unknown`: se lee con
   * `prefijosPorCiudad`). Ausente o `{}` = todas con `prefijoConsecutivo`.
   */
  prefijoConsecutivoPorCiudad?: unknown;
}

function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/**
 * Mapa ciudad → prefijo de la configuración. Lo que no sea un texto no vacío
 * se ignora aquí; `validarConfigContador` lo reporta como error.
 */
export function prefijosPorCiudad(
  config: Pick<ConfigConsecutivo, "prefijoConsecutivoPorCiudad">,
): Record<string, string> {
  const valor = config.prefijoConsecutivoPorCiudad;
  if (!esObjetoPlano(valor)) return {};
  const salida: Record<string, string> = {};
  for (const [ciudad, prefijo] of Object.entries(valor)) {
    if (typeof prefijo === "string" && prefijo !== "") salida[ciudad] = prefijo;
  }
  return salida;
}

/** Prefijo con el que se imprime un DO de esta ciudad (el del mapa solo cuenta con `CIUDAD_ANIO`). */
export function prefijoDeCiudad(config: ConfigConsecutivo, ciudad: string): string {
  if (config.secuenciaPor !== "CIUDAD_ANIO") return config.prefijoConsecutivo;
  return prefijosPorCiudad(config)[ciudad] ?? config.prefijoConsecutivo;
}

/**
 * Raíz del consecutivo: el texto que va antes del año (`DO.BAQ`, `DO.EXP`,
 * `DO.EXP.CTG`, `CLAS`). En un contador global (sin año) es el prefijo (`PV`).
 */
export function raizConsecutivo(config: ConfigConsecutivo, ciudad: string): string {
  const prefijo = prefijoDeCiudad(config, ciudad);
  if (config.secuenciaPor === "GLOBAL") return prefijo;
  return config.incluyeCiudadEnConsecutivo ? `${prefijo}.${ciudad}` : prefijo;
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
  const raiz = raizConsecutivo(config, ciudad);

  if (config.secuenciaPor === "GLOBAL") {
    return `${raiz}-${secuencial}`;
  }

  return `${raiz}${String(anio).slice(-2)}-${secuencial}`;
}

/** Alcance de UN contador: qué DOs cuentan para el siguiente número. */
export interface AlcanceContador<C extends string = string> {
  /**
   * Nombre del contador: `IMPORTACION:BAQ+BGT+BUN:2026`, `IMPORTACION:CTG:2026`,
   * `EXPORTACION:BAQ+BGT+BUN:2026`, `EXPORTACION:CTG:2026`, `OTRO:2026`,
   * `PLAN_VALLEJO`. Es la clave de `consecutivo_piso`.
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
 * de candado que antes del 30-sep-2026. El prefijo por ciudad no cambia el
 * alcance: solo cómo se imprime el número.
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

// ─── Choques entre contadores (30-sep-2026) ─────────────────────────────────
//
// Un consecutivo es `raíz + AA + "-" + número` (o `raíz + "-" + número` en un
// contador global). El número son solo dígitos, así que lo que va antes del
// último guion identifica al contador: dos contadores DISTINTOS imprimen el
// mismo texto si y solo si ese «comienzo» coincide. Con año: misma raíz. Global
// contra uno con año: la raíz global es la otra raíz + dos dígitos (`PV26`
// contra `PV` + año). `tramite_do.consecutivo` es único: un choque no duplica un
// DO, pero deja a un contador trabado en el número que ya tomó el otro.

/** Cómo imprime un contador los números de una ciudad (o de cualquiera). */
export interface PatronNumeracion {
  tipoTramiteCodigo: string;
  /** Contador sin año: `EXPORTACION:BAQ+BGT+BUN`, `EXPORTACION:CTG`, `OTRO`. */
  contador: string;
  /** `null` = el número no depende de la ciudad (contador por año o global sin ciudad). */
  ciudad: string | null;
  raiz: string;
  /** false = contador global: el número no lleva año. */
  conAnio: boolean;
}

/** Ciudades a revisar: las que se pasan más las que nombra la configuración (sin repetir). */
function ciudadesDeConfig(config: ConfigConsecutivo, ciudades: readonly string[]): string[] {
  const valor = config.prefijoConsecutivoPorCiudad;
  const delMapa = esObjetoPlano(valor) ? Object.keys(valor) : [];
  return [...new Set([...ciudades, ...(config.ciudadesContadorComun ?? []), ...delMapa])];
}

/** Patrones de numeración de un tipo: uno por ciudad (o uno solo si la ciudad no cuenta). */
export function patronesDeNumeracion(
  config: ConfigConsecutivo,
  tipoTramiteCodigo: string,
  ciudades: readonly string[],
): PatronNumeracion[] {
  const ciudadNoCuenta =
    config.secuenciaPor === "GLOBAL" || (config.secuenciaPor === "ANIO" && !config.incluyeCiudadEnConsecutivo);
  const lista = ciudadesDeConfig(config, ciudades);
  if (ciudadNoCuenta || lista.length === 0) {
    return [
      {
        tipoTramiteCodigo,
        contador: tipoTramiteCodigo,
        ciudad: null,
        raiz: config.secuenciaPor === "CIUDAD_ANIO" ? config.prefijoConsecutivo : raizConsecutivo(config, ""),
        conAnio: config.secuenciaPor !== "GLOBAL",
      },
    ];
  }
  return lista.map((ciudad) => {
    const alcance = alcanceContador(config, tipoTramiteCodigo, ciudad, 0);
    return {
      tipoTramiteCodigo,
      contador: alcance.ciudades ? `${tipoTramiteCodigo}:${alcance.ciudades.join("+")}` : tipoTramiteCodigo,
      ciudad,
      raiz: raizConsecutivo(config, ciudad),
      conAnio: config.secuenciaPor !== "GLOBAL",
    };
  });
}

function raicesChocan(a: PatronNumeracion, b: PatronNumeracion): boolean {
  if (a.conAnio === b.conAnio) return a.raiz === b.raiz;
  const [global, anual] = a.conAnio ? [b, a] : [a, b];
  return (
    global.raiz.length === anual.raiz.length + 2 &&
    global.raiz.startsWith(anual.raiz) &&
    /^\d{2}$/.test(global.raiz.slice(-2))
  );
}

/** Dos patrones de contadores DISTINTOS que pueden imprimir el mismo consecutivo. */
export interface ChoqueNumeracion {
  a: PatronNumeracion;
  b: PatronNumeracion;
}

/** Choques entre contadores distintos (un choque por par de contadores). */
export function choquesDeNumeracion(patrones: readonly PatronNumeracion[]): ChoqueNumeracion[] {
  const choques: ChoqueNumeracion[] = [];
  const vistos = new Set<string>();
  for (let i = 0; i < patrones.length; i += 1) {
    for (let j = i + 1; j < patrones.length; j += 1) {
      const a = patrones[i];
      const b = patrones[j];
      if (a.contador === b.contador || !raicesChocan(a, b)) continue;
      const par = [a.contador, b.contador].sort().join("|");
      if (vistos.has(par)) continue;
      vistos.add(par);
      choques.push({ a, b });
    }
  }
  return choques;
}

function describirRaiz(p: PatronNumeracion): string {
  return p.conAnio ? `«${p.raiz}» + año + número` : `«${p.raiz}» + número`;
}

function nombrePatron(p: PatronNumeracion, conTipo: boolean): string {
  const partes = [conTipo ? p.tipoTramiteCodigo : null, p.ciudad].filter((x): x is string => Boolean(x));
  return partes.length > 0 ? partes.join(" ") : p.tipoTramiteCodigo;
}

function mensajeChoque({ a, b }: ChoqueNumeracion, conTipo: boolean): string {
  const forma = a.conAnio === b.conAnio ? describirRaiz(a) : `${describirRaiz(a)} y ${describirRaiz(b)}`;
  return (
    `Los contadores ${nombrePatron(a, conTipo)} y ${nombrePatron(b, conTipo)} son distintos pero ` +
    `imprimirían el mismo número (${forma}). Dale a uno su propio prefijo ` +
    `(prefijoConsecutivoPorCiudad) o júntalos en un solo contador (ciudadesContadorComun).`
  );
}

function validarPrefijosPorCiudad(config: ConfigConsecutivo, ciudades: readonly string[]): string | null {
  const valor = config.prefijoConsecutivoPorCiudad;
  if (valor === undefined || valor === null) return null;
  if (!esObjetoPlano(valor)) {
    return 'El prefijo por ciudad debe ser un mapa ciudad → prefijo, p. ej. {"CTG": "DO.EXP.CTG"}.';
  }
  const entradas = Object.entries(valor);
  if (entradas.length === 0) return null;
  if (config.secuenciaPor !== "CIUDAD_ANIO") {
    return "El prefijo por ciudad solo aplica a un contador por ciudad y año.";
  }
  for (const [ciudad, prefijo] of entradas) {
    if (ciudades.length > 0 && !ciudades.includes(ciudad)) {
      return `El prefijo por ciudad nombra una ciudad que no existe: ${ciudad}.`;
    }
    if (typeof prefijo !== "string" || prefijo === "" || /\s/.test(prefijo)) {
      return `El prefijo de ${ciudad} debe ser un texto sin espacios, p. ej. "DO.EXP.CTG".`;
    }
  }
  return null;
}

/**
 * Error de configuración del contador de UN tipo (`null` si está bien):
 *   - las ciudades comunes solo tienen sentido con `CIUDAD_ANIO` y no se repiten;
 *   - el prefijo por ciudad solo con `CIUDAD_ANIO`, con ciudades que existen y
 *     prefijos sin espacios;
 *   - dos contadores distintos del tipo no pueden imprimir el mismo número
 *     (p. ej. número sin ciudad y dos contadores con el mismo prefijo).
 * `ciudades` = todas las ciudades posibles (el enum `Ciudad`); sin ella solo
 * se revisan las que nombra la configuración.
 */
export function validarConfigContador(config: ConfigConsecutivo, ciudades: readonly string[] = []): string | null {
  const comunes = config.ciudadesContadorComun ?? [];
  if (comunes.length > 0) {
    if (config.secuenciaPor !== "CIUDAD_ANIO") {
      return "Las ciudades con contador compartido solo aplican a un contador por ciudad y año.";
    }
    if (new Set(comunes).size !== comunes.length) {
      return "Hay ciudades repetidas en el contador compartido.";
    }
  }
  if (!config.prefijoConsecutivo || /\s/.test(config.prefijoConsecutivo)) {
    return "El prefijo del consecutivo no puede estar vacío ni tener espacios.";
  }
  const errorPrefijos = validarPrefijosPorCiudad(config, ciudades);
  if (errorPrefijos) return errorPrefijos;

  const [choque] = choquesDeNumeracion(patronesDeNumeracion(config, "", ciudades));
  return choque ? mensajeChoque(choque, false) : null;
}

/** Un problema de numeración del catálogo y a qué tipos toca. */
export interface ProblemaNumeracion {
  tipos: string[];
  mensaje: string;
}

/**
 * Problemas de numeración de TODO el catálogo: los de cada tipo
 * (`validarConfigContador`) y los choques entre tipos (p. ej. una Exportación
 * de Cartagena con prefijo `DO.CTG` imprimiría los números de la importación
 * de Cartagena). `createTramite` no numera un tipo con problemas.
 */
export function problemasDeNumeracion(
  tipos: ReadonlyArray<ConfigConsecutivo & { codigo: string }>,
  ciudades: readonly string[],
): ProblemaNumeracion[] {
  const problemas: ProblemaNumeracion[] = [];
  const patrones: PatronNumeracion[] = [];
  for (const tipo of tipos) {
    const error = validarConfigContador(tipo, ciudades);
    if (error) {
      problemas.push({ tipos: [tipo.codigo], mensaje: `${tipo.codigo}: ${error}` });
      continue;
    }
    patrones.push(...patronesDeNumeracion(tipo, tipo.codigo, ciudades));
  }
  for (const choque of choquesDeNumeracion(patrones)) {
    // Dentro de un mismo tipo ya lo reportó `validarConfigContador`.
    if (choque.a.tipoTramiteCodigo === choque.b.tipoTramiteCodigo) continue;
    problemas.push({
      tipos: [choque.a.tipoTramiteCodigo, choque.b.tipoTramiteCodigo],
      mensaje: mensajeChoque(choque, true),
    });
  }
  return problemas;
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

/**
 * Etiqueta del contador para la pantalla: «contador compartido Barranquilla,
 * Bogotá y Buenaventura», «contador de Cartagena», «contador de otros servicios».
 * Con `nombrarTipo` (el número no lleva la ciudad, p. ej. Exportación) la
 * etiqueta dice el tipo: «contador de exportación Barranquilla, Bogotá y
 * Buenaventura», «contador de exportación de Cartagena».
 */
export function etiquetaContador(
  alcance: Pick<AlcanceContador, "ciudades">,
  nombreCiudad: (ciudad: string) => string,
  nombreTipo: string,
  nombrarTipo = false,
): string {
  const tipo = nombreTipo.toLowerCase();
  if (!alcance.ciudades) return `contador de ${tipo}`;
  const nombres = alcance.ciudades.map(nombreCiudad);
  if (nombres.length === 1) {
    return nombrarTipo ? `contador de ${tipo} de ${nombres[0]}` : `contador de ${nombres[0]}`;
  }
  const lista = `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
  return nombrarTipo ? `contador de ${tipo} ${lista}` : `contador compartido ${lista}`;
}
