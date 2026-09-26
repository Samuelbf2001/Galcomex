import { describe, expect, it } from "vitest";

import {
  EMAIL_USUARIO_CARGA_HISTORICA,
  TITULO_CARTERA_HISTORICA,
  esFacturaHistoricaSinCobros,
  interpretarCarteraHistoricaAparte,
  whereFacturaHistoricaSinCobros,
} from "../historica";

/** Factura de un trámite histórico emitida por la carga del histórico. */
const deCarga = { esHistorico: true, deCargaHistorica: true } as const;

describe("esFacturaHistoricaSinCobros", () => {
  it("de la carga histórica, sin pagos → sí", () => {
    expect(esFacturaHistoricaSinCobros({ ...deCarga, pagos: [] })).toBe(true);
  });

  it("de la carga histórica con un ABONO del CLIENTE → no (sale sola al primer cobro)", () => {
    expect(esFacturaHistoricaSinCobros({ ...deCarga, pagos: [{ destino: "CLIENTE" }] })).toBe(false);
  });

  it("de la carga histórica con una DEVOLUCION al CLIENTE → no (cualquier tipo cuenta)", () => {
    const pagos = [{ destino: "CLIENTE", tipo: "DEVOLUCION" }];
    expect(esFacturaHistoricaSinCobros({ ...deCarga, pagos })).toBe(false);
  });

  it("de la carga histórica solo con pagos a LM → sí (no son cobros del cliente)", () => {
    expect(esFacturaHistoricaSinCobros({ ...deCarga, pagos: [{ destino: "LM" }] })).toBe(true);
  });

  it("factura NUEVA de la plataforma sobre un DO histórico → no (es deuda real desde el primer día)", () => {
    expect(esFacturaHistoricaSinCobros({ esHistorico: true, deCargaHistorica: false, pagos: [] })).toBe(false);
  });

  it("no histórica → no, tenga o no pagos, y aunque la haya facturado el usuario de la carga", () => {
    expect(esFacturaHistoricaSinCobros({ esHistorico: false, deCargaHistorica: false, pagos: [] })).toBe(false);
    expect(esFacturaHistoricaSinCobros({ esHistorico: false, deCargaHistorica: true, pagos: [] })).toBe(false);
    expect(esFacturaHistoricaSinCobros({ esHistorico: false, deCargaHistorica: true, pagos: [{ destino: "CLIENTE" }] })).toBe(false);
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
  it("es una conjunción explícita de las tres condiciones (para que NOT las niegue juntas)", () => {
    expect(Object.keys(whereFacturaHistoricaSinCobros)).toEqual(["AND"]);
    expect(whereFacturaHistoricaSinCobros.AND).toHaveLength(3);
  });

  it("exige que el borrador lo haya facturado el usuario de las cargas del histórico", () => {
    expect(whereFacturaHistoricaSinCobros.AND[1]).toEqual({
      borrador: { is: { facturadoPor: { is: { email: EMAIL_USUARIO_CARGA_HISTORICA } } } },
    });
    expect(EMAIL_USUARIO_CARGA_HISTORICA).toBe("importacion@galcomex.com");
  });

  it("título exacto de la sección del tablero", () => {
    expect(TITULO_CARTERA_HISTORICA).toBe("Cartera histórica 2026 (cobros aún no cargados)");
  });
});
