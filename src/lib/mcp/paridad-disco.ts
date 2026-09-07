/**
 * Carga desde disco lo que `paridad.ts` compara. Separado del cálculo puro para
 * que el test y el script compartan exactamente la misma lectura.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { ArchivoRuta } from "@/lib/mcp/paridad";

export const RAIZ_APP = process.cwd();
export const DIR_API = resolve(RAIZ_APP, "src", "app", "api");
export const ARCHIVO_MCP = resolve(RAIZ_APP, "..", "galcomex-mcp", "server.mjs");

function listarRouteTs(dir: string): string[] {
  const resultado: string[] = [];

  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) {
      resultado.push(...listarRouteTs(ruta));
    } else if (entrada === "route.ts") {
      resultado.push(ruta);
    }
  }

  return resultado;
}

export function cargarRutasApi(): ArchivoRuta[] {
  const base = resolve(RAIZ_APP, "src", "app");

  return listarRouteTs(DIR_API)
    .sort()
    .map((absoluta) => ({
      ruta: "/" + relative(base, absoluta).split(sep).join("/"),
      contenido: readFileSync(absoluta, "utf8"),
    }));
}

export function existeServidorMcp(): boolean {
  return existsSync(ARCHIVO_MCP);
}

export function cargarFuenteMcp(): string {
  return readFileSync(ARCHIVO_MCP, "utf8");
}
