/**
 * Paridad API ↔ MCP — Galcomex
 *
 * FUNCIONES PURAS, SIN BD NI DISCO. Reciben el texto de los archivos y devuelven
 * qué endpoints de `src/app/api/**` no tienen una tool dedicada en
 * `galcomex-mcp/server.mjs`, y qué tools apuntan a rutas que ya no existen.
 *
 * Por qué existe: la regla del proyecto es que la UI y el MCP son dos clientes
 * de la misma API, así que "todo lo que se hace en la UI lo puede hacer un
 * agente". Hasta hoy eso era disciplina; con este chequeo es una garantía que
 * corre en `npm test`.
 *
 * Normalización: cualquier segmento dinámico —`[id]`, `[pagoId]`, `${a.x}`,
 * `${encodeURIComponent(x)}`— se colapsa a `[param]`, así `PATCH
 * /api/tramites/[id]/pagos/[pagoId]` y `PATCH /api/tramites/${t}/pagos/${p}` son
 * el mismo endpoint.
 */

export const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Metodo = (typeof METODOS)[number];

export interface Endpoint {
  metodo: Metodo;
  /** Ruta normalizada, p. ej. `/api/clientes/[param]/capacidades`. */
  ruta: string;
}

export interface ArchivoRuta {
  /** Ruta del archivo relativa a `src/app`, p. ej. `/api/clientes/[id]/route.ts`. */
  ruta: string;
  contenido: string;
}

export interface Excepcion extends Endpoint {
  /** Por qué este endpoint no tiene (o no necesita) tool dedicada. */
  razon: string;
}

export interface ResultadoParidad {
  /** Endpoints de la API sin tool dedicada y sin excepción declarada. */
  sinTool: Endpoint[];
  /** Tools del MCP que apuntan a un endpoint que no existe. */
  sinEndpoint: Endpoint[];
  /** Excepciones declaradas que ya no hacen falta (el endpoint ganó tool o desapareció). */
  excepcionesObsoletas: Excepcion[];
  cubiertos: number;
  totalApi: number;
}

export function normalizarRuta(ruta: string): string {
  return ruta
    .replace(/\$\{[^}]*\}/g, "[param]")
    .replace(/\[\.{3}[^\]]+\]/g, "[param]")
    .replace(/\[[^\]]+\]/g, "[param]")
    .replace(/\/+$/, "");
}

export function claveEndpoint(endpoint: Endpoint): string {
  return `${endpoint.metodo} ${endpoint.ruta}`;
}

/**
 * Extrae los endpoints que exporta cada `route.ts`. Reconoce
 * `export async function GET`, `export function GET` y `export const PATCH = PUT`.
 */
export function endpointsDesdeRutas(archivos: ArchivoRuta[]): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const patronSimple = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const)\\s+(${METODOS.join("|")})\\b`,
    "gm",
  );
  // `export const { GET, POST } = toNextJsHandler(auth)` — Better Auth.
  const patronDestructuring = /^export\s+const\s+\{([^}]*)\}\s*=/gm;

  for (const archivo of archivos) {
    const ruta = normalizarRuta(archivo.ruta.replace(/\/route\.ts$/, ""));
    const vistos = new Set<string>();
    const agregar = (metodo: string) => {
      if (!(METODOS as readonly string[]).includes(metodo) || vistos.has(metodo)) return;
      vistos.add(metodo);
      endpoints.push({ metodo: metodo as Metodo, ruta });
    };

    for (const coincidencia of archivo.contenido.matchAll(patronSimple)) {
      agregar(coincidencia[1]!);
    }

    for (const coincidencia of archivo.contenido.matchAll(patronDestructuring)) {
      for (const nombre of coincidencia[1]!.split(",")) {
        agregar(nombre.trim());
      }
    }
  }

  return endpoints;
}

/**
 * Extrae los endpoints a los que llama el servidor MCP vía `api("METODO", ruta)`.
 * Acepta rutas entre comillas o en template literal.
 */
export function endpointsDesdeMcp(fuente: string): Endpoint[] {
  const patron = new RegExp(
    `api\\(\\s*"(${METODOS.join("|")})"\\s*,\\s*(?:\`([^\`]*)\`|"([^"]*)")`,
    "g",
  );
  const endpoints = new Map<string, Endpoint>();

  for (const coincidencia of fuente.matchAll(patron)) {
    const metodo = coincidencia[1] as Metodo;
    const cruda = coincidencia[2] ?? coincidencia[3] ?? "";
    // Solo la parte de la ruta: sin query string.
    const ruta = normalizarRuta(cruda.split("?")[0] ?? "");
    const endpoint = { metodo, ruta };
    endpoints.set(claveEndpoint(endpoint), endpoint);
  }

  return [...endpoints.values()];
}

export function compararParidad(
  api: Endpoint[],
  mcp: Endpoint[],
  excepciones: Excepcion[] = [],
): ResultadoParidad {
  const clavesMcp = new Set(mcp.map(claveEndpoint));
  const clavesApi = new Set(api.map(claveEndpoint));
  const clavesExcepcion = new Set(excepciones.map(claveEndpoint));

  const sinTool = api.filter(
    (endpoint) =>
      !clavesMcp.has(claveEndpoint(endpoint)) &&
      !clavesExcepcion.has(claveEndpoint(endpoint)),
  );

  const sinEndpoint = mcp.filter((endpoint) => !clavesApi.has(claveEndpoint(endpoint)));

  const excepcionesObsoletas = excepciones.filter(
    (excepcion) =>
      !clavesApi.has(claveEndpoint(excepcion)) || clavesMcp.has(claveEndpoint(excepcion)),
  );

  const cubiertos = api.filter((endpoint) => clavesMcp.has(claveEndpoint(endpoint))).length;

  return { sinTool, sinEndpoint, excepcionesObsoletas, cubiertos, totalApi: api.length };
}

export function formatearReporte(resultado: ResultadoParidad): string {
  const lineas: string[] = [];
  const porcentaje =
    resultado.totalApi === 0
      ? 0
      : Math.round((resultado.cubiertos / resultado.totalApi) * 100);

  lineas.push(
    `Paridad API ↔ MCP: ${resultado.cubiertos}/${resultado.totalApi} endpoints con tool dedicada (${porcentaje}%)`,
  );

  if (resultado.sinTool.length > 0) {
    lineas.push("", "✗ Endpoints SIN tool MCP ni excepción declarada:");
    for (const endpoint of resultado.sinTool) {
      lineas.push(`    ${claveEndpoint(endpoint)}`);
    }
  }

  if (resultado.sinEndpoint.length > 0) {
    lineas.push("", "✗ Tools MCP que apuntan a rutas que NO existen:");
    for (const endpoint of resultado.sinEndpoint) {
      lineas.push(`    ${claveEndpoint(endpoint)}`);
    }
  }

  if (resultado.excepcionesObsoletas.length > 0) {
    lineas.push("", "· Excepciones que ya no hacen falta (limpiar la lista):");
    for (const excepcion of resultado.excepcionesObsoletas) {
      lineas.push(`    ${claveEndpoint(excepcion)} — ${excepcion.razon}`);
    }
  }

  if (
    resultado.sinTool.length === 0 &&
    resultado.sinEndpoint.length === 0 &&
    resultado.excepcionesObsoletas.length === 0
  ) {
    lineas.push("✓ Todo endpoint tiene tool o excepción declarada, y toda tool apunta a una ruta viva.");
  }

  return lineas.join("\n");
}
