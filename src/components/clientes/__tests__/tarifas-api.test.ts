import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CIUDADES,
  describirCalculo,
  etiquetaCiudad,
  fetchAlcancesFlujoCorto,
  fetchTarifarios,
} from "@/components/clientes/tarifas-api";

/** B3 (Diseño A) — helpers de ciudad del cliente HTTP de tarifarios. */
describe("etiquetaCiudad / CIUDADES", () => {
  it("tiene las 5 ciudades del enum, incluida Bogotá (BGT)", () => {
    expect(CIUDADES.map((c) => c.value).sort()).toEqual(["BAQ", "BGT", "BUN", "CTG", "SMR"].sort());
  });

  it("traduce el código a un nombre legible", () => {
    expect(etiquetaCiudad("BGT")).toBe("Bogotá");
    expect(etiquetaCiudad("CTG")).toBe("Cartagena");
  });

  it("un código desconocido se devuelve tal cual (defensivo)", () => {
    expect(etiquetaCiudad("XXX")).toBe("XXX");
  });
});

/** B2 y B6 (Diseño B) — servicio de «Otros» y espejo por proveedor en el cliente HTTP de tarifarios. */
describe("Diseño B — cliente HTTP de tarifarios", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respuesta(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it("B2 — fetchAlcancesFlujoCorto toma del catálogo de tipos los alcances de flujo corto (sin repetir)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respuesta({
          tipos: [
            { codigo: "IMPORTACION", lineaServicio: "TRAMITE", flujoCorto: false },
            { codigo: "CLASIFICACION", lineaServicio: "CLASIFICACION", flujoCorto: false },
            { codigo: "OTRO", lineaServicio: "OTROS", flujoCorto: true },
            { codigo: "OTRO_2", lineaServicio: "OTROS", flujoCorto: true },
          ],
        }),
      ),
    );
    expect(await fetchAlcancesFlujoCorto()).toEqual(["OTROS"]);
  });

  it("B2 — un tarifario trae su servicio (código y nombre); una tarifa sin servicio queda en null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respuesta({
          tarifarios: [
            { id: "t1", alcance: "OTROS", conceptoServicioCodigo: "DUTA", conceptoServicio: { codigo: "DUTA", nombre: "DUTA (tránsito aduanero)" }, items: [] },
            { id: "t2", alcance: "TRAMITE", conceptoServicioCodigo: null, conceptoServicio: null, items: [] },
          ],
        }),
      ),
    );
    const lista = await fetchTarifarios("cliente-1");
    expect(lista[0]).toMatchObject({ conceptoServicioCodigo: "DUTA", conceptoServicioNombre: "DUTA (tránsito aduanero)" });
    expect(lista[1]).toMatchObject({ conceptoServicioCodigo: null, conceptoServicioNombre: null });
  });

  it("B6 — un ítem «Lo mismo que costó» por proveedor se describe con el NIT y el mínimo; el viejo, con su texto", () => {
    const base = {
      id: "i1", orden: 70, concepto: "ELABORACION_REGISTRO", nombrePublico: "ELABORACION REGISTRO", siigoCodigo: "010",
      tipoCalculo: "ESPEJO_DE_COSTO" as const, disparador: "EVENTO" as const, eventoCodigo: "ELABORACION_REGISTRO", unidad: "TRAMITE" as const,
      valorAdicional: null, porcentajeBps: null, minimos: null, tramos: null, aplicaIva: true, notas: null,
      restaAgenciamiento: false, minimoEsDelTotal: false,
    };
    const porProveedor = describirCalculo({ ...base, valor: "150000", conceptoCosto: null, nitProveedorCosto: "830115297", productoCosto: "24" });
    expect(porProveedor).toContain("NIT 830115297");
    expect(porProveedor).toContain("producto 24");
    expect(porProveedor).toContain("mín.");
    expect(porProveedor).toContain("150.000");
    expect(describirCalculo({ ...base, valor: "0", conceptoCosto: "registro", nitProveedorCosto: null, productoCosto: null })).toBe('Lo que costó "registro"');
  });
});
