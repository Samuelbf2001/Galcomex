/**
 * Tope del abono (decisión de Ernesto, 25-sep-2026) — función pura, sin BD.
 * Tolerancia 0 pesos.
 */
import { describe, expect, it } from "vitest";

import { repartirAbono } from "../tope-abono";

describe("repartirAbono", () => {
  it("abono menor que lo que se debe: todo a la factura, sin sobrante", () => {
    expect(repartirAbono(-1_000_000n, 400_000n)).toEqual({
      pendiente: 1_000_000n,
      aLaFactura: 400_000n,
      excedente: 0n,
    });
  });

  it("abono exacto: salda la factura, sin sobrante", () => {
    expect(repartirAbono(-1_000_000n, 1_000_000n)).toEqual({
      pendiente: 1_000_000n,
      aLaFactura: 1_000_000n,
      excedente: 0n,
    });
  });

  it("ejemplo de Ernesto: debe 1.000.000 y llegan 1.200.000 → 1.000.000 a la factura y 200.000 de sobrante", () => {
    expect(repartirAbono(-1_000_000n, 1_200_000n)).toEqual({
      pendiente: 1_000_000n,
      aLaFactura: 1_000_000n,
      excedente: 200_000n,
    });
  });

  it("factura saldada (neto 0): todo el abono es sobrante", () => {
    expect(repartirAbono(0n, 50_000n)).toEqual({ pendiente: 0n, aLaFactura: 0n, excedente: 50_000n });
  });

  it("factura con saldo a favor del cliente (neto > 0): no hay nada que cobrar", () => {
    expect(repartirAbono(3_357_958n, 10_000n)).toEqual({
      pendiente: 0n,
      aLaFactura: 0n,
      excedente: 10_000n,
    });
  });

  it("aLaFactura + excedente = monto siempre (sin perder un peso)", () => {
    for (const [neto, monto] of [
      [-1n, 1n],
      [-1n, 2n],
      [-987_654_321n, 987_654_322n],
      [-5n, 3n],
      [7n, 9n],
    ] as const) {
      const r = repartirAbono(neto, monto);
      expect(r.aLaFactura + r.excedente).toBe(monto);
      expect(r.aLaFactura <= r.pendiente).toBe(true);
    }
  });
});
