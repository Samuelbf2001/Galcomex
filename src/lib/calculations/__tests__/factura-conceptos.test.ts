import { describe, expect, it } from "vitest";

import {
  calcularFacturaConceptos,
  impuesto4x1000SobreTerceros,
  ivaDeItem,
  reteIvaSobre,
} from "../factura-conceptos";

const BASE = { tasaIva: 19n, tasa4x1000: 400n, reteIvaPorcentaje: 15, retencionesManuales: 0n };
const conIva = (valor: bigint) => ({ valor, aplicaIva: true });

describe("calcularFacturaConceptos — casos dorados de Siigo (tolerancia 0)", () => {
  it("BAQ-18385 Litoplas DO.26-0069: terceros + 4x1000 + conceptos con IVA − ReteIVA", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [502_801n, 99_484n, 486_075n],
      conceptos: [conIva(200_000n), conIva(20_000n), conIva(20_000n), conIva(100_000n)],
      totalAnticipo: 1_418_000n,
    });

    expect(r.baseTerceros).toBe(1_088_360n);
    expect(r.impuesto4x1000).toBe(4_353n);
    expect(r.baseConceptos).toBe(340_000n);
    expect(r.iva).toBe(64_600n);
    expect(r.retenciones).toBe(9_690n);
    expect(r.totalFactura).toBe(1_487_623n);
    expect(r.saldoACargoCliente).toBe(69_623n);
    expect(r.saldoAFavorCliente).toBe(0n);
  });

  it("BAQ-18357 Litoplas DO.26-0059: sin terceros no hay 4x1000 y queda saldo a favor", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [],
      conceptos: [conIva(200_000n), conIva(80_000n), conIva(20_000n), conIva(100_000n)],
      totalAnticipo: 476_000n,
    });

    expect(r.impuesto4x1000).toBe(0n);
    expect(r.iva).toBe(76_000n);
    expect(r.retenciones).toBe(11_400n);
    expect(r.totalFactura).toBe(464_600n);
    expect(r.saldoAFavorCliente).toBe(11_400n);
    expect(r.saldoACargoCliente).toBe(0n);
  });

  it("sin ReteIVA configurada usa las retenciones manuales", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      reteIvaPorcentaje: null,
      retencionesManuales: 1_000n,
      terceros: [],
      conceptos: [conIva(100_000n)],
      totalAnticipo: 0n,
    });
    expect(r.retenciones).toBe(1_000n);
    expect(r.totalFactura).toBe(118_000n);
    expect(r.saldoACargoCliente).toBe(118_000n);
  });

  it("los conceptos sin IVA suman a la base pero no generan IVA", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [],
      conceptos: [conIva(100_000n), { valor: 41_900n, aplicaIva: false }],
      totalAnticipo: 0n,
    });
    expect(r.baseConceptos).toBe(141_900n);
    expect(r.baseIva).toBe(100_000n);
    expect(r.iva).toBe(19_000n);
  });
});

describe("redondeos al peso", () => {
  it("4x1000 redondea la mitad hacia arriba", () => {
    expect(impuesto4x1000SobreTerceros(1_088_360n, 400n)).toBe(4_353n); // 4.353,44
    expect(impuesto4x1000SobreTerceros(1_125n, 400n)).toBe(5n); // 4,5
    expect(impuesto4x1000SobreTerceros(0n, 400n)).toBe(0n);
  });

  it("IVA y ReteIVA por ítem", () => {
    expect(ivaDeItem(20_000n, 19n)).toBe(3_800n);
    expect(ivaDeItem(12_345n, 19n)).toBe(2_346n); // 2.345,55
    expect(reteIvaSobre(64_600n, 15)).toBe(9_690n);
  });
});
