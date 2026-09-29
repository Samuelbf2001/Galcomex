import { describe, expect, it } from "vitest";

import {
  tarifaItemSchema,
  tarifarioDuplicarSchema,
  tarifarioSchema,
  tarifarioUpdateSchema,
} from "../tarifas";

/**
 * Diseño A (27-sep-2026) — validaciones Zod de B1 (restar el agenciamiento)
 * y B3 (tarifario por ciudad). Puras, sin BD.
 */

const itemBase = {
  concepto: "ASESORIA",
  nombrePublico: "Asesoría",
  tipoCalculo: "PORCENTAJE_MIN" as const,
  porcentajeBps: 20,
  minimos: { SUELTA: "305000" },
};

describe("tarifaItemSchema — B1 restaAgenciamiento / minimoEsDelTotal", () => {
  it("por defecto no resta y el mínimo no es del total", () => {
    const item = tarifaItemSchema.parse(itemBase);
    expect(item.restaAgenciamiento).toBe(false);
    expect(item.minimoEsDelTotal).toBe(false);
  });

  it("acepta restaAgenciamiento en un ítem % del CIF con mínimo", () => {
    const item = tarifaItemSchema.parse({ ...itemBase, restaAgenciamiento: true });
    expect(item.restaAgenciamiento).toBe(true);
  });

  it("un ítem MANUAL no puede restar la agencia", () => {
    expect(() =>
      tarifaItemSchema.parse({ ...itemBase, disparador: "MANUAL", restaAgenciamiento: true }),
    ).toThrow(/manual no resta la agencia/);
  });

  it("un ítem ESPEJO_DE_COSTO no puede restar la agencia", () => {
    expect(() =>
      tarifaItemSchema.parse({
        concepto: "REGISTRO_VUCE",
        nombrePublico: "Registro VUCE",
        tipoCalculo: "ESPEJO_DE_COSTO",
        conceptoCosto: "vuce",
        restaAgenciamiento: true,
      }),
    ).toThrow(/espejo de costo no resta/);
  });

  it("minimoEsDelTotal sin restaAgenciamiento es un error", () => {
    expect(() => tarifaItemSchema.parse({ ...itemBase, minimoEsDelTotal: true })).toThrow(
      /solo aplica cuando el ítem resta la agencia/,
    );
  });

  it("minimoEsDelTotal sin PORCENTAJE_MIN es un error", () => {
    expect(() =>
      tarifaItemSchema.parse({
        concepto: "SERVICIO",
        nombrePublico: "Servicio",
        tipoCalculo: "POR_UNIDAD",
        unidad: "CONTENEDOR",
        valor: "600000",
        restaAgenciamiento: true,
        minimoEsDelTotal: true,
      }),
    ).toThrow(/solo aplica a «% del CIF con mínimo»/);
  });

  it("restaAgenciamiento + minimoEsDelTotal juntos en % del CIF con mínimo: ok", () => {
    expect(() =>
      tarifaItemSchema.parse({ ...itemBase, minimos: { SUELTA: "450000" }, restaAgenciamiento: true, minimoEsDelTotal: true }),
    ).not.toThrow();
  });
});

describe("tarifarioSchema — B1: la agencia se resta una sola vez por DO", () => {
  const base = { vigenteDesde: "2026-01-01", vigenteHasta: "2026-12-31", nombre: "Tarifario" };

  it("un solo ítem con resta: ok", () => {
    expect(() =>
      tarifarioSchema.parse({ ...base, items: [{ ...itemBase, restaAgenciamiento: true }] }),
    ).not.toThrow();
  });

  it("dos ítems con resta en el mismo tarifario: 422", () => {
    expect(() =>
      tarifarioSchema.parse({
        ...base,
        items: [
          { ...itemBase, concepto: "ASESORIA", restaAgenciamiento: true },
          { ...itemBase, concepto: "NACIONALIZACION", restaAgenciamiento: true },
        ],
      }),
    ).toThrow(/se resta una sola vez por DO/);
  });
});

describe("tarifarioSchema / tarifarioUpdateSchema / tarifarioDuplicarSchema — B3 ciudades", () => {
  const base = { vigenteDesde: "2026-01-01", vigenteHasta: "2026-12-31", nombre: "Tarifario" };

  it("sin ciudades: válido (queda undefined, el servicio lo trata como general)", () => {
    const t = tarifarioSchema.parse({ ...base });
    expect(t.ciudades).toBeUndefined();
  });

  it("acepta una lista de ciudades sin repetir", () => {
    const t = tarifarioSchema.parse({ ...base, ciudades: ["BGT", "CTG"] });
    expect(t.ciudades).toEqual(["BGT", "CTG"]);
  });

  it("rechaza ciudades repetidas", () => {
    expect(() => tarifarioSchema.parse({ ...base, ciudades: ["BGT", "BGT"] })).toThrow(/repetida/);
  });

  it("rechaza más de 5 ciudades", () => {
    expect(() =>
      tarifarioSchema.parse({ ...base, ciudades: ["BGT", "CTG", "BAQ", "BUN", "SMR", "BGT"] }),
    ).toThrow();
  });

  it("tarifarioUpdateSchema acepta ciudades opcional", () => {
    expect(tarifarioUpdateSchema.parse({}).ciudades).toBeUndefined();
    expect(tarifarioUpdateSchema.parse({ ciudades: ["BGT"] }).ciudades).toEqual(["BGT"]);
  });

  it("tarifarioDuplicarSchema acepta ciudades opcional", () => {
    const sinCiudades = tarifarioDuplicarSchema.parse({ vigenteDesde: "2026-01-01", vigenteHasta: "2026-12-31" });
    expect(sinCiudades.ciudades).toBeUndefined();
    const conCiudades = tarifarioDuplicarSchema.parse({
      vigenteDesde: "2026-01-01",
      vigenteHasta: "2026-12-31",
      ciudades: ["BGT"],
    });
    expect(conCiudades.ciudades).toEqual(["BGT"]);
  });
});
