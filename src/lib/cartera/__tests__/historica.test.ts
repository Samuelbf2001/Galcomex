import { describe, expect, it } from "vitest";

import {
  TITULO_CARTERA_HISTORICA,
  esFacturaHistoricaSinCobros,
  interpretarCarteraHistoricaAparte,
  whereFacturaHistoricaSinCobros,
} from "../historica";

describe("esFacturaHistoricaSinCobros", () => {
  it("histórica sin pagos → sí", () => {
    expect(esFacturaHistoricaSinCobros({ esHistorico: true, pagos: [] })).toBe(true);
  });

  it("histórica con un ABONO del CLIENTE → no (sale sola al primer cobro)", () => {
    expect(esFacturaHistoricaSinCobros({ esHistorico: true, pagos: [{ destino: "CLIENTE" }] })).toBe(false);
  });

  it("histórica con una DEVOLUCION al CLIENTE → no (cualquier tipo cuenta)", () => {
    const pagos = [{ destino: "CLIENTE", tipo: "DEVOLUCION" }];
    expect(esFacturaHistoricaSinCobros({ esHistorico: true, pagos })).toBe(false);
  });

  it("histórica solo con pagos a LM → sí (no son cobros del cliente)", () => {
    expect(esFacturaHistoricaSinCobros({ esHistorico: true, pagos: [{ destino: "LM" }] })).toBe(true);
  });

  it("no histórica → no, tenga o no pagos", () => {
    expect(esFacturaHistoricaSinCobros({ esHistorico: false, pagos: [] })).toBe(false);
    expect(esFacturaHistoricaSinCobros({ esHistorico: false, pagos: [{ destino: "CLIENTE" }] })).toBe(false);
  });
});

describe("interpretarCarteraHistoricaAparte", () => {
  it("solo NO apaga la separación (sin importar mayúsculas ni espacios)", () => {
    expect(interpretarCarteraHistoricaAparte("NO")).toBe(false);
    expect(interpretarCarteraHistoricaAparte(" no ")).toBe(false);
    expect(interpretarCarteraHistoricaAparte("No")).toBe(false);
  });

  it("SI, vacío, fila ausente o cualquier otro valor la dejan activa", () => {
    expect(interpretarCarteraHistoricaAparte("SI")).toBe(true);
    expect(interpretarCarteraHistoricaAparte("")).toBe(true);
    expect(interpretarCarteraHistoricaAparte(null)).toBe(true);
    expect(interpretarCarteraHistoricaAparte(undefined)).toBe(true);
    expect(interpretarCarteraHistoricaAparte("NOPE")).toBe(true);
  });
});

describe("whereFacturaHistoricaSinCobros", () => {
  it("es una conjunción explícita (para que NOT niegue las dos condiciones juntas)", () => {
    expect(Object.keys(whereFacturaHistoricaSinCobros)).toEqual(["AND"]);
    expect(whereFacturaHistoricaSinCobros.AND).toHaveLength(2);
  });

  it("título exacto de la sección del tablero", () => {
    expect(TITULO_CARTERA_HISTORICA).toBe("Cartera histórica 2026 (cobros aún no cargados)");
  });
});
