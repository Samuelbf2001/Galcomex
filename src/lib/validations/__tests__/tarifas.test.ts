import { describe, expect, it } from "vitest";

import { tarifaItemSchema, tarifaItemUpdateSchema } from "../tarifas";

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
