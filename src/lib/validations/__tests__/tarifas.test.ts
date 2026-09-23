import { describe, expect, it } from "vitest";

import { tarifaItemSchema, tarifaItemUpdateSchema, tarifariosListQuerySchema, tarifarioSchema } from "../tarifas";

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
    expect(payload.valor).toBe(200_000n);
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
