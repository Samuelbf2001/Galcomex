/**
 * Resolución de capacidades — Galcomex
 *
 * FUNCIÓN PURA, SIN BD (misma disciplina que `lib/calculations/motor-factura.ts`).
 * Toda la lógica de precedencia vive aquí para poder probarla al detalle sin
 * levantar Postgres.
 *
 * Cascada:
 *
 *     Capacidad.porDefecto  →  override de grupo económico  →  override de empresa
 *
 * `habilitado` y `config` se resuelven POR SEPARADO: cada uno toma el nivel más
 * específico que lo define. Eso permite que el grupo económico fije la config
 * (por ejemplo la comisión por contenedor) y que cada empresa del grupo se
 * limite a encender o apagar la función.
 *
 * Una capacidad con `activa: false` en el catálogo queda apagada pase lo que
 * pase: es el interruptor de emergencia para retirar una función sin borrar la
 * configuración que las empresas ya tengan cargada.
 */

export type ConfigCapacidad = Record<string, unknown> | null;

export type OrigenCapacidad = "DEFECTO" | "GRUPO" | "EMPRESA" | "CATALOGO";

/** Definición del catálogo, en la forma mínima que necesita el resolver. */
export interface DefinicionResoluble {
  codigo: string;
  porDefecto: boolean;
  configPorDefecto?: ConfigCapacidad;
  /** `false` fuerza la capacidad apagada sin importar los overrides. */
  activa?: boolean;
}

/** Override de un nivel (grupo o empresa). */
export interface OverrideCapacidad {
  codigo: string;
  /** `null`/`undefined` = este nivel no opina sobre el encendido. */
  habilitado?: boolean | null;
  /** `null`/`undefined` = este nivel no opina sobre la config. */
  config?: ConfigCapacidad;
}

export interface CapacidadResuelta {
  codigo: string;
  habilitado: boolean;
  config: ConfigCapacidad;
  origenHabilitado: OrigenCapacidad;
  origenConfig: OrigenCapacidad;
}

export type MapaCapacidades = ReadonlyMap<string, CapacidadResuelta>;

function indexar(overrides: readonly OverrideCapacidad[]): Map<string, OverrideCapacidad> {
  const mapa = new Map<string, OverrideCapacidad>();

  for (const override of overrides) {
    // El último gana: la BD no permite duplicados por PK compuesta, pero el
    // resolver no depende de esa garantía.
    mapa.set(override.codigo, override);
  }

  return mapa;
}

function tieneConfig(override: OverrideCapacidad | undefined): boolean {
  return override?.config !== undefined && override?.config !== null;
}

function tieneHabilitado(override: OverrideCapacidad | undefined): boolean {
  return override?.habilitado !== undefined && override?.habilitado !== null;
}

/**
 * Resuelve el mapa de capacidades efectivas de una empresa.
 *
 * Solo aparecen los códigos presentes en `definiciones`: un override huérfano
 * (capacidad retirada del catálogo) se ignora en vez de filtrarse a los
 * consumidores.
 */
export function resolverCapacidades(
  definiciones: readonly DefinicionResoluble[],
  overridesGrupo: readonly OverrideCapacidad[] = [],
  overridesEmpresa: readonly OverrideCapacidad[] = [],
): MapaCapacidades {
  const porGrupo = indexar(overridesGrupo);
  const porEmpresa = indexar(overridesEmpresa);
  const resultado = new Map<string, CapacidadResuelta>();

  for (const definicion of definiciones) {
    const grupo = porGrupo.get(definicion.codigo);
    const empresa = porEmpresa.get(definicion.codigo);

    let habilitado = definicion.porDefecto;
    let origenHabilitado: OrigenCapacidad = "DEFECTO";

    if (tieneHabilitado(grupo)) {
      habilitado = grupo!.habilitado === true;
      origenHabilitado = "GRUPO";
    }

    if (tieneHabilitado(empresa)) {
      habilitado = empresa!.habilitado === true;
      origenHabilitado = "EMPRESA";
    }

    let config: ConfigCapacidad = definicion.configPorDefecto ?? null;
    let origenConfig: OrigenCapacidad = "DEFECTO";

    if (tieneConfig(grupo)) {
      config = grupo!.config ?? null;
      origenConfig = "GRUPO";
    }

    if (tieneConfig(empresa)) {
      config = empresa!.config ?? null;
      origenConfig = "EMPRESA";
    }

    if (definicion.activa === false) {
      habilitado = false;
      origenHabilitado = "CATALOGO";
    }

    resultado.set(definicion.codigo, {
      codigo: definicion.codigo,
      habilitado,
      config,
      origenHabilitado,
      origenConfig,
    });
  }

  return resultado;
}

/** `true` solo si la capacidad existe en el catálogo y quedó encendida. */
export function tiene(mapa: MapaCapacidades, codigo: string): boolean {
  return mapa.get(codigo)?.habilitado === true;
}

/**
 * Config efectiva de una capacidad ENCENDIDA. Devuelve `null` si la capacidad
 * está apagada, no existe o no tiene config: apagada es apagada, y leer su
 * config sería una fuente silenciosa de bugs.
 */
export function configDe<T extends Record<string, unknown>>(
  mapa: MapaCapacidades,
  codigo: string,
): T | null {
  const resuelta = mapa.get(codigo);

  if (!resuelta || !resuelta.habilitado) {
    return null;
  }

  return (resuelta.config as T | null) ?? null;
}

/** Códigos encendidos, ordenados — útil para logs y auditoría. */
export function capacidadesActivas(mapa: MapaCapacidades): string[] {
  return [...mapa.values()]
    .filter((capacidad) => capacidad.habilitado)
    .map((capacidad) => capacidad.codigo)
    .sort();
}
