import { describe, expect, it } from "vitest";

import { pesos } from "@/lib/dinero";

import {
  minimosTarifaSchema,
  tarifaItemSchema,
  tarifaItemUpdateSchema,
  tarifarioDuplicarSchema,
  tarifariosListQuerySchema,
  tarifarioSchema,
  tramosTarifaSchema,
} from "../tarifas";

describe("tarifaItemUpdateSchema — edición parcial de un ítem", () => {
  it("solo devuelve los campos enviados (no aplica valores por defecto)", () => {
    const payload = tarifaItemUpdateSchema.parse({ nombrePublico: "REVISION DOCUMENTAL" });

    expect(payload).toEqual({ nombrePublico: "REVISION DOCUMENTAL" });
    expect(payload.disparador).toBeUndefined();
    expect(payload.unidad).toBeUndefined();
    expect(payload.valor).toBeUndefined();
    expect(payload.aplicaIva).toBeUndefined();
    expect(payload.orden).toBeUndefined();
  });

  it("valida y convierte los campos que sí vienen", () => {
    const payload = tarifaItemUpdateSchema.parse({ valor: "200000", unidad: "DOCUMENTO" });
    expect(payload.valor).toBe(pesos(200_000));
    expect(payload.unidad).toBe("DOCUMENTO");
  });
});

describe("tarifaItemSchema — alta de un ítem", () => {
  it("sigue aplicando los valores por defecto al crear", () => {
    const item = tarifaItemSchema.parse({
      concepto: "GASTOS_TRAMITE",
      nombrePublico: "Gastos de trámite",
      tipoCalculo: "FIJO",
      valor: "100000",
    });
    expect(item.disparador).toBe("SIEMPRE");
    expect(item.unidad).toBe("TRAMITE");
    expect(item.aplicaIva).toBe(true);
    expect(item.orden).toBe(0);
  });

  it("sin valor: 0n centavos", () => {
    const item = tarifaItemSchema.parse({
      concepto: "PAGO_REGISTRO",
      nombrePublico: "Pago de registro",
      tipoCalculo: "ESPEJO_DE_COSTO",
      conceptoCosto: "registro",
    });
    expect(item.valor).toBe(0n);
  });
});

// Fase centavos (A.2 / B.4): valor en PESOS → centavos; minimos/tramos PESOS texto canónico.
describe("tarifas — dinero en centavos", () => {
  const base = { concepto: "X", nombrePublico: "X", tipoCalculo: "FIJO" };

  it("valor y valorAdicional: pesos (texto o number) → centavos; admite centavos", () => {
    expect(tarifaItemSchema.parse({ ...base, valor: "100000" }).valor).toBe(pesos(100_000));
    expect(tarifaItemSchema.parse({ ...base, valor: "100000.50" }).valor).toBe(10_000_050n);
    expect(tarifaItemSchema.parse({ ...base, valor: 100000 }).valor).toBe(pesos(100_000));
    const pma = tarifaItemSchema.parse({
      ...base,
      tipoCalculo: "PRIMERO_MAS_ADICIONAL",
      unidad: "ITEM",
      valor: "380000",
      valorAdicional: "180000.25",
    });
    expect(pma.valorAdicional).toBe(18_000_025n);
  });

  it("valor: rechaza formato humano, más de 2 decimales, negativos y bigint crudo", () => {
    for (const malo of ["100.000", "100000,50", "100000.555", "-1", "1e5"]) {
      expect(tarifaItemSchema.safeParse({ ...base, valor: malo }).success).toBe(false);
    }
    expect(tarifaItemSchema.safeParse({ ...base, valor: 100_000n }).success).toBe(false);
  });

  it("minimos: se guardan en forma canónica (sin .00) y conservan centavos", () => {
    expect(minimosTarifaSchema.parse({ SUELTA: "370000", CONTENEDOR_20: "498000.00", CONTENEDOR_40: "554000.5" })).toEqual({
      SUELTA: "370000",
      CONTENEDOR_20: "498000",
      CONTENEDOR_40: "554000.50",
    });
    expect(minimosTarifaSchema.safeParse({ SUELTA: "370.000" }).success).toBe(false);
    expect(minimosTarifaSchema.safeParse({ SUELTA: "370000.555" }).success).toBe(false);
    expect(minimosTarifaSchema.safeParse({ SUELTA: "-1" }).success).toBe(false);
  });

  it("tramos: valor canónico; heredado intacto", () => {
    expect(
      tramosTarifaSchema.parse([
        { hasta: 1, valor: "300000" },
        { hasta: null, valor: "250000.00" },
      ]),
    ).toEqual([
      { hasta: 1, valor: "300000" },
      { hasta: null, valor: "250000" },
    ]);
    expect(tramosTarifaSchema.parse([{ hasta: null, valor: "250000.45" }])).toEqual([{ hasta: null, valor: "250000.45" }]);
    expect(tramosTarifaSchema.safeParse([{ hasta: null, valor: "250.000" }]).success).toBe(false);
  });

  it("duplicar: redondeoA sigue siendo PESOS enteros (1.000 por defecto)", () => {
    const d = tarifarioDuplicarSchema.parse({ vigenteDesde: "2027-01-01", vigenteHasta: "2027-12-31", incrementoPct: 5.29 });
    expect(d.redondeoA).toBe(1_000);
  });
});

// B2 (22-sep): "Arrancar desde" — plantilla y tarifario de origen son
// mutuamente excluyentes.
describe("tarifarioSchema — plantilla vs origenTarifarioId", () => {
  const base = { vigenteDesde: "2026-01-01", vigenteHasta: "2026-12-31" };

  it("acepta plantilla sola", () => {
    expect(() => tarifarioSchema.parse({ ...base, plantilla: "LITOPLAS_IMPO_2026" })).not.toThrow();
  });

  it("acepta origenTarifarioId solo", () => {
    expect(() => tarifarioSchema.parse({ ...base, origenTarifarioId: "cabc123", nombre: "Copia" })).not.toThrow();
  });

  it("acepta ninguno (en blanco)", () => {
    expect(() => tarifarioSchema.parse({ ...base, nombre: "En blanco" })).not.toThrow();
  });

  it("rechaza los dos a la vez", () => {
    expect(() =>
      tarifarioSchema.parse({ ...base, plantilla: "LITOPLAS_IMPO_2026", origenTarifarioId: "cabc123" }),
    ).toThrow(/una plantilla o un tarifario de origen/);
  });
});

describe("tarifariosListQuerySchema — GET /api/tarifarios", () => {
  it("excluirEmpresaId es opcional", () => {
    expect(tarifariosListQuerySchema.parse({})).toEqual({});
  });

  it("acepta excluirEmpresaId", () => {
    expect(tarifariosListQuerySchema.parse({ excluirEmpresaId: "cabc123" })).toEqual({
      excluirEmpresaId: "cabc123",
    });
  });
});
