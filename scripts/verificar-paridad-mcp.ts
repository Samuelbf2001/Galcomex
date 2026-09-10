/**
 * Reporte de paridad API ↔ MCP.
 *
 *   npx tsx scripts/verificar-paridad-mcp.ts
 *
 * Imprime qué endpoints tienen tool dedicada, cuáles están declarados como
 * deuda (PENDIENTE) y cuáles son huecos sin declarar. Sale con código 1 si hay
 * huecos o tools rotas — el mismo criterio que el test en `npm test`.
 */

import {
  claveEndpoint,
  compararParidad,
  endpointsDesdeMcp,
  endpointsDesdeRutas,
  formatearReporte,
} from "../src/lib/mcp/paridad";
import {
  ARCHIVO_MCP,
  cargarFuenteMcp,
  cargarRutasApi,
  existeServidorMcp,
} from "../src/lib/mcp/paridad-disco";
import { EXCEPCIONES_PARIDAD } from "../src/lib/mcp/paridad-excepciones";

if (!existeServidorMcp()) {
  console.error(`✗ No encuentro el servidor MCP en ${ARCHIVO_MCP}`);
  process.exit(1);
}

const resultado = compararParidad(
  endpointsDesdeRutas(cargarRutasApi()),
  endpointsDesdeMcp(cargarFuenteMcp()),
  EXCEPCIONES_PARIDAD,
);

console.log(formatearReporte(resultado));

const pendientes = EXCEPCIONES_PARIDAD.filter((e) => e.tipo === "PENDIENTE");
const intencionales = EXCEPCIONES_PARIDAD.filter((e) => e.tipo === "INTENCIONAL");

console.log(
  `\nExcepciones declaradas: ${intencionales.length} intencionales · ${pendientes.length} pendientes (deuda)`,
);

if (pendientes.length > 0) {
  console.log("\nDeuda declarada — endpoints que deberían tener tool y aún no:");
  for (const e of pendientes) {
    console.log(`    ${claveEndpoint(e).padEnd(64)} ${e.razon}`);
  }
}

const falla =
  resultado.sinTool.length > 0 ||
  resultado.sinEndpoint.length > 0 ||
  resultado.excepcionesObsoletas.length > 0;

process.exit(falla ? 1 : 0);
