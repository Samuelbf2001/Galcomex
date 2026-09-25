import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTramitesPage } from "./tramites-api";

/**
 * D0: la fila de la lista cuenta los documentos pendientes SIN el ítem
 * "CUADRE DE PLATA HISTÓRICA" (que se muestra aparte como "Cuadre pendiente").
 */

const CUADRE = "CUADRE DE PLATA HISTÓRICA · ROJO";

function respuesta(tramites: unknown[]) {
  return new Response(JSON.stringify({ tramites, total: tramites.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fila(id: string, esHistorico: boolean, checklistItems: { descripcion: string; requerido: boolean; recibido: boolean }[]) {
  return { id, consecutivo: `DO.BAQ26-${id}`, estado: "FACTURADO", ciudad: "BAQ", esHistorico, checklistItems };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTramitesPage — conteo de pendientes y marca de cuadre", () => {
  it("histórico con solo el cuadre pendiente: 0 documentos, cuadre pendiente", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respuesta([fila("0001", true, [{ descripcion: CUADRE, requerido: true, recibido: false }])])));

    const { rows } = await fetchTramitesPage();

    expect(rows[0]).toMatchObject({ documentosPendientes: 0, cuadrePendiente: true, tieneCuadre: true, esHistorico: true });
  });

  it("histórico con cuadre y 2 documentos pendientes: 2 documentos + cuadre pendiente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respuesta([
          fila("0002", true, [
            { descripcion: "BL", requerido: true, recibido: false },
            { descripcion: "Factura comercial", requerido: true, recibido: false },
            { descripcion: CUADRE, requerido: true, recibido: false },
          ]),
        ]),
      ),
    );

    const { rows } = await fetchTramitesPage();

    expect(rows[0]).toMatchObject({ documentosPendientes: 2, cuadrePendiente: true, tieneCuadre: true });
  });

  it("histórico con el cuadre cerrado: tiene cuadre, no pendiente", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respuesta([fila("0003", true, [{ descripcion: CUADRE, requerido: true, recibido: true }])])));

    const { rows } = await fetchTramitesPage();

    expect(rows[0]).toMatchObject({ documentosPendientes: 0, cuadrePendiente: false, tieneCuadre: true });
  });

  it("el mismo texto en un DO no histórico cuenta como documento normal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respuesta([fila("0004", false, [{ descripcion: CUADRE, requerido: true, recibido: false }])])));

    const { rows } = await fetchTramitesPage();

    expect(rows[0]).toMatchObject({ documentosPendientes: 1, cuadrePendiente: false, tieneCuadre: false, esHistorico: false });
  });
});
