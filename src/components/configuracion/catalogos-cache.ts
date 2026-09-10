/**
 * Caché de catálogos de la página de Configuración.
 *
 * Varias secciones de `/configuracion` (Catálogos Siigo, Configuración de
 * envío Siigo, Beneficiarios) necesitan los mismos listados. Antes cada una
 * disparaba su propio `fetch` al montar (12 llamadas al abrir la página, varias
 * al mismo endpoint). Aquí se comparte UNA promesa por catálogo:
 *
 *  - Si dos secciones piden el mismo catálogo al mismo tiempo, solo viaja una
 *    petición (dedupe de peticiones en vuelo).
 *  - El resultado se conserva un rato corto (TTL) para que expandir un acordeón
 *    justo después de abrir la página no vuelva a pedir lo mismo.
 *  - Tras una sincronización o edición se llama `invalidarCatalogos(...)` para
 *    que la próxima lectura sea fresca.
 *
 * Los fetchers originales (`siigo-productos-api.ts`, `beneficiario-api.ts`) no
 * cambian: otros módulos (p. ej. el editor de líneas) los siguen usando sin
 * caché.
 */

import {
  fetchBeneficiarios,
  type BeneficiarioRow,
} from "@/components/beneficiarios/beneficiario-api";
import {
  fetchSiigoFormasPago,
  fetchSiigoImpuestos,
  fetchSiigoProductos,
  fetchSiigoTiposComprobante,
  fetchSiigoVendedores,
  type SiigoFormasPagoPayload,
  type SiigoImpuestosPayload,
  type SiigoProductosPayload,
  type SiigoTiposComprobantePayload,
  type SiigoVendedoresPayload,
} from "@/components/configuracion/siigo-productos-api";

export type CatalogoConfig =
  | "productos"
  | "impuestos"
  | "formasPago"
  | "tiposComprobante"
  | "vendedores"
  | "beneficiarios";

/** Tiempo que un resultado se considera fresco (dedupe entre secciones). */
const TTL_MS = 60_000;

type Entrada = { promesa: Promise<unknown>; creadoEn: number };

const cache = new Map<CatalogoConfig, Entrada>();

function cacheado<T>(clave: CatalogoConfig, cargar: () => Promise<T>): Promise<T> {
  const ahora = Date.now();
  const actual = cache.get(clave);
  if (actual && ahora - actual.creadoEn < TTL_MS) {
    return actual.promesa as Promise<T>;
  }

  const entrada: Entrada = { promesa: Promise.resolve(), creadoEn: ahora };
  entrada.promesa = cargar().catch((caught: unknown) => {
    // Un fallo no se memoriza: el siguiente intento vuelve a pedir.
    if (cache.get(clave) === entrada) cache.delete(clave);
    throw caught;
  });
  cache.set(clave, entrada);
  return entrada.promesa as Promise<T>;
}

/** Olvida uno o varios catálogos (sin argumentos: todos). */
export function invalidarCatalogos(...claves: CatalogoConfig[]): void {
  if (claves.length === 0) {
    cache.clear();
    return;
  }
  for (const clave of claves) cache.delete(clave);
}

export function catalogoProductos(): Promise<SiigoProductosPayload> {
  return cacheado("productos", () => fetchSiigoProductos());
}

export function catalogoImpuestos(): Promise<SiigoImpuestosPayload> {
  return cacheado("impuestos", () => fetchSiigoImpuestos());
}

export function catalogoFormasPago(): Promise<SiigoFormasPagoPayload> {
  return cacheado("formasPago", () => fetchSiigoFormasPago());
}

export function catalogoTiposComprobante(): Promise<SiigoTiposComprobantePayload> {
  return cacheado("tiposComprobante", () => fetchSiigoTiposComprobante());
}

export function catalogoVendedores(): Promise<SiigoVendedoresPayload> {
  return cacheado("vendedores", () => fetchSiigoVendedores());
}

export function catalogoBeneficiarios(): Promise<BeneficiarioRow[]> {
  return cacheado("beneficiarios", () => fetchBeneficiarios());
}
