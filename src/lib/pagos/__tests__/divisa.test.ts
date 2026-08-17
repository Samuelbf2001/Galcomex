/**
 * Tests unitarios PUROS (sin BD) — regla todo-o-nada de campos de divisa (A2,
 * reunión 1-jul-2026: "abren un campo y se coloca la tasa con que se pagó").
 */
import { describe, expect, it } from "vitest";

import {
  camposDivisaAusentes,
  camposDivisaCompletos,
  camposDivisaValidos,
  esDecimalValido,
} from "../divisa";

describe("camposDivisaValidos", () => {
  it("los tres ausentes (undefined) → válido", () => {
    expect(camposDivisaValidos({})).toBe(true);
  });

  it("los tres ausentes (null explícito) → válido", () => {
    expect(
      camposDivisaValidos({ moneda: null, valorDivisa: null, tasaCambio: null }),
    ).toBe(true);
  });

  it("los tres presentes → válido", () => {
    expect(
      camposDivisaValidos({
        moneda: "USD",
        valorDivisa: 123_456n,
        tasaCambio: "4200.50",
      }),
    ).toBe(true);
  });

  it("mezcla de undefined y null también cuenta como 'ausente' si ninguno tiene valor real", () => {
    expect(
      camposDivisaValidos({ moneda: null, valorDivisa: undefined, tasaCambio: null }),
    ).toBe(true);
  });

  it("solo moneda presente → inválido", () => {
    expect(camposDivisaValidos({ moneda: "USD" })).toBe(false);
  });

  it("solo valorDivisa presente → inválido", () => {
    expect(camposDivisaValidos({ valorDivisa: 100_000n })).toBe(false);
  });

  it("solo tasaCambio presente → inválido", () => {
    expect(camposDivisaValidos({ tasaCambio: "4200" })).toBe(false);
  });

  it("dos de tres presentes → inválido", () => {
    expect(
      camposDivisaValidos({ moneda: "USD", valorDivisa: 100_000n }),
    ).toBe(false);
  });

  it("caso BAQ-18453: pago vinculado sin divisa (COP puro) → válido (ausentes)", () => {
    expect(
      camposDivisaValidos({ moneda: null, valorDivisa: null, tasaCambio: null }),
    ).toBe(true);
  });
});

describe("camposDivisaCompletos / camposDivisaAusentes", () => {
  it("son mutuamente excluyentes para el caso completo", () => {
    const completo = { moneda: "USD", valorDivisa: 1n, tasaCambio: "1" };
    expect(camposDivisaCompletos(completo)).toBe(true);
    expect(camposDivisaAusentes(completo)).toBe(false);
  });

  it("son mutuamente excluyentes para el caso ausente", () => {
    expect(camposDivisaCompletos({})).toBe(false);
    expect(camposDivisaAusentes({})).toBe(true);
  });

  it("un caso parcial no es ni completo ni ausente", () => {
    const parcial = { moneda: "USD" };
    expect(camposDivisaCompletos(parcial)).toBe(false);
    expect(camposDivisaAusentes(parcial)).toBe(false);
  });
});

describe("esDecimalValido", () => {
  it("acepta enteros", () => {
    expect(esDecimalValido("4200")).toBe(true);
  });

  it("acepta decimales", () => {
    expect(esDecimalValido("4200.5")).toBe(true);
    expect(esDecimalValido("4200.53")).toBe(true);
  });

  it("rechaza negativos (la TRM no es negativa)", () => {
    expect(esDecimalValido("-4200")).toBe(false);
  });

  it("rechaza separadores de miles", () => {
    expect(esDecimalValido("4.200,50")).toBe(false);
  });

  it("rechaza vacío o no numérico", () => {
    expect(esDecimalValido("")).toBe(false);
    expect(esDecimalValido("abc")).toBe(false);
  });

  it("tolera espacios en los extremos", () => {
    expect(esDecimalValido("  4200.50  ")).toBe(true);
  });
});
