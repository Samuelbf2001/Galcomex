/**
 * Paridad API ↔ MCP.
 *
 * Primera parte: la lógica pura con entradas sintéticas.
 * Segunda parte: el "trinquete" contra el repo real — cualquier endpoint nuevo
 * sin tool MCP y sin excepción declarada hace fallar `npm test`. La deuda
 * conocida vive en `paridad-excepciones.ts` como PENDIENTE y puede bajar, nunca
 * subir sin declararlo.
 */
import { describe, expect, it } from "vitest";

import {
  claveEndpoint,
  compararParidad,
  endpointsDesdeMcp,
  endpointsDesdeRutas,
  formatearReporte,
  normalizarRuta,
} from "@/lib/mcp/paridad";
import {
  cargarFuenteMcp,
  cargarRutasApi,
  existeServidorMcp,
} from "@/lib/mcp/paridad-disco";
import { EXCEPCIONES_PARIDAD } from "@/lib/mcp/paridad-excepciones";

describe("normalizarRuta", () => {
  it("colapsa segmentos dinámicos de Next y de template literal a [param]", () => {
    expect(normalizarRuta("/api/clientes/[id]/capacidades")).toBe(
      "/api/clientes/[param]/capacidades",
    );
    expect(normalizarRuta("/api/tramites/${a.tramiteId}/pagos/${pagoId}")).toBe(
      "/api/tramites/[param]/pagos/[param]",
    );
    expect(normalizarRuta("/api/parametros/${encodeURIComponent(a.clave)}")).toBe(
      "/api/parametros/[param]",
    );
    expect(normalizarRuta("/api/auth/[...all]")).toBe("/api/auth/[param]");
  });
});

describe("endpointsDesdeRutas", () => {
  it("reconoce function, async function, const y alias", () => {
    const endpoints = endpointsDesdeRutas([
      {
        ruta: "/api/tramites/[id]/route.ts",
        contenido: [
          "export async function GET() {}",
          "export const PATCH = PUT;",
          "export async function PUT() {}",
          "function DELETE() {} // no exportada",
        ].join("\n"),
      },
    ]);

    expect(endpoints.map(claveEndpoint).sort()).toEqual([
      "GET /api/tramites/[param]",
      "PATCH /api/tramites/[param]",
      "PUT /api/tramites/[param]",
    ]);
  });

  it("reconoce el destructuring de Better Auth", () => {
    const endpoints = endpointsDesdeRutas([
      {
        ruta: "/api/auth/[...all]/route.ts",
        contenido: "export const { GET, POST } = toNextJsHandler(auth);",
      },
    ]);

    expect(endpoints.map(claveEndpoint).sort()).toEqual([
      "GET /api/auth/[param]",
      "POST /api/auth/[param]",
    ]);
  });
});

describe("endpointsDesdeMcp", () => {
  it("lee llamadas api() con comillas y con template literal, y descarta el query string", () => {
    const fuente = [
      'handler: () => api("GET", "/api/dashboard"),',
      "handler: (a) => api(\"PATCH\", `/api/tramites/${a.tramiteId}/pagos/${a.pagoId}`, { body }),",
      'handler: () => api("GET", "/api/tramites?estado=X"),',
      'handler: () => api("GET", "/api/dashboard"), // duplicada',
    ].join("\n");

    expect(endpointsDesdeMcp(fuente).map(claveEndpoint).sort()).toEqual([
      "GET /api/dashboard",
      "GET /api/tramites",
      "PATCH /api/tramites/[param]/pagos/[param]",
    ]);
  });
});

describe("compararParidad", () => {
  const api = endpointsDesdeRutas([
    { ruta: "/api/a/route.ts", contenido: "export async function GET() {}" },
    { ruta: "/api/b/route.ts", contenido: "export async function POST() {}" },
    { ruta: "/api/c/[id]/route.ts", contenido: "export async function DELETE() {}" },
  ]);

  it("detecta endpoints sin tool y tools sin endpoint", () => {
    const mcp = endpointsDesdeMcp('api("GET", "/api/a"); api("GET", "/api/zzz");');
    const resultado = compararParidad(api, mcp);

    expect(resultado.sinTool.map(claveEndpoint)).toEqual(["POST /api/b", "DELETE /api/c/[param]"]);
    expect(resultado.sinEndpoint.map(claveEndpoint)).toEqual(["GET /api/zzz"]);
    expect(resultado.cubiertos).toBe(1);
    expect(resultado.totalApi).toBe(3);
  });

  it("una excepción declarada saca el endpoint de la lista", () => {
    const mcp = endpointsDesdeMcp('api("GET", "/api/a");');
    const resultado = compararParidad(api, mcp, [
      { metodo: "POST", ruta: "/api/b", razon: "público" },
    ]);

    expect(resultado.sinTool.map(claveEndpoint)).toEqual(["DELETE /api/c/[param]"]);
    expect(resultado.excepcionesObsoletas).toEqual([]);
  });

  it("avisa cuando una excepción ya no hace falta", () => {
    const mcp = endpointsDesdeMcp('api("GET", "/api/a"); api("POST", "/api/b");');
    const resultado = compararParidad(api, mcp, [
      { metodo: "POST", ruta: "/api/b", razon: "ya tiene tool" },
      { metodo: "GET", ruta: "/api/borrada", razon: "el endpoint ya no existe" },
    ]);

    expect(resultado.excepcionesObsoletas.map(claveEndpoint)).toEqual([
      "POST /api/b",
      "GET /api/borrada",
    ]);
  });

  it("el reporte celebra cuando todo cuadra", () => {
    const mcp = endpointsDesdeMcp(
      'api("GET", "/api/a"); api("POST", "/api/b"); api("DELETE", `/api/c/${x}`);',
    );

    expect(formatearReporte(compararParidad(api, mcp))).toContain("✓ Todo endpoint tiene tool");
  });
});

describe("trinquete contra el repo real", () => {
  it("todo endpoint nuevo tiene tool MCP o excepción declarada, y toda tool apunta a una ruta viva", (ctx) => {
    if (!existeServidorMcp()) {
      ctx.skip("galcomex-mcp/server.mjs no está junto al repo; se omite el trinquete");
    }

    const resultado = compararParidad(
      endpointsDesdeRutas(cargarRutasApi()),
      endpointsDesdeMcp(cargarFuenteMcp()),
      EXCEPCIONES_PARIDAD,
    );

    const reporte = formatearReporte(resultado);

    expect(resultado.sinTool, `Endpoints sin tool ni excepción:\n${reporte}`).toEqual([]);
    expect(resultado.sinEndpoint, `Tools rotas:\n${reporte}`).toEqual([]);
    expect(
      resultado.excepcionesObsoletas,
      `Excepciones obsoletas — bórralas de paridad-excepciones.ts:\n${reporte}`,
    ).toEqual([]);
  });

  it("no hay excepciones repetidas", () => {
    const claves = EXCEPCIONES_PARIDAD.map(claveEndpoint);
    expect(new Set(claves).size).toBe(claves.length);
  });
});
