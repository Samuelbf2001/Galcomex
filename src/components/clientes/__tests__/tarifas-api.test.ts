import { describe, expect, it } from "vitest";

import { CIUDADES, etiquetaCiudad } from "@/components/clientes/tarifas-api";

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
