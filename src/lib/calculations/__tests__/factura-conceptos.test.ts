import { describe, expect, it } from "vitest";
import { pesos } from "@/lib/dinero";
import { $ } from "@/lib/dinero/test-utils";

import {
  calcularFacturaConceptos,
  impuesto4x1000SobreTerceros,
  ivaDeItem,
  PRECISION_4X1000_FACTURA,
  PRECISION_IVA,
  PRECISION_RETEIVA,
  reteIvaSobre,
} from "../factura-conceptos";

const BASE = { tasaIva: 19n, tasa4x1000: 400n, reteIvaPorcentaje: 15, retencionesManuales: 0n };
const conIva = (valor: bigint) => ({ valor, aplicaIva: true });

describe("calcularFacturaConceptos — casos dorados de Siigo (tolerancia 0 centavos)", () => {
  it("BAQ-18385 EXACTO al centavo (factura real Siigo 1.487.623,45 / a cargo 69.623,45)", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [$("502.801,45"), pesos(99_484), pesos(486_075)],
      conceptos: [conIva(pesos(200_000)), conIva(pesos(20_000)), conIva(pesos(20_000)), conIva(pesos(100_000))],
      totalAnticipo: pesos(1_418_000),
    });

    expect(r.baseTerceros).toBe(108_836_045n); // 1.088.360,45
    expect(r.impuesto4x1000).toBe(435_300n); // 4.353,44 → 4.353 (al peso)
    expect(r.baseConceptos).toBe(34_000_000n);
    expect(r.iva).toBe(6_460_000n);
    expect(r.retenciones).toBe(969_000n);
    expect(r.totalFactura).toBe(148_762_345n); // 1.487.623,45
    expect(r.saldoACargoCliente).toBe(6_962_345n); // 69.623,45
    expect(r.saldoAFavorCliente).toBe(0n);
    expect(r.totalFactura).toBe($("1.487.623,45"));
    expect(r.saldoACargoCliente).toBe($("69.623,45"));
  });

  it("BAQ-18385 histórico en pesos enteros (502.801): idéntico ×100", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [pesos(502_801), pesos(99_484), pesos(486_075)],
      conceptos: [conIva(pesos(200_000)), conIva(pesos(20_000)), conIva(pesos(20_000)), conIva(pesos(100_000))],
      totalAnticipo: pesos(1_418_000),
    });

    expect(r.baseTerceros).toBe(pesos(1_088_360));
    expect(r.impuesto4x1000).toBe(pesos(4_353));
    expect(r.baseConceptos).toBe(pesos(340_000));
    expect(r.iva).toBe(pesos(64_600));
    expect(r.retenciones).toBe(pesos(9_690));
    expect(r.totalFactura).toBe(pesos(1_487_623));
    expect(r.saldoACargoCliente).toBe(pesos(69_623));
    expect(r.saldoAFavorCliente).toBe(0n);
  });

  it("BAQ-18357 Litoplas DO.26-0059: sin terceros no hay 4x1000 y queda saldo a favor", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [],
      conceptos: [conIva(pesos(200_000)), conIva(pesos(80_000)), conIva(pesos(20_000)), conIva(pesos(100_000))],
      totalAnticipo: pesos(476_000),
    });

    expect(r.impuesto4x1000).toBe(0n);
    expect(r.iva).toBe(pesos(76_000));
    expect(r.retenciones).toBe(pesos(11_400));
    expect(r.totalFactura).toBe(pesos(464_600));
    expect(r.saldoAFavorCliente).toBe(pesos(11_400));
    expect(r.saldoACargoCliente).toBe(0n);
  });

  it("sin ReteIVA configurada usa las retenciones manuales", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      reteIvaPorcentaje: null,
      retencionesManuales: pesos(1_000),
      terceros: [],
      conceptos: [conIva(pesos(100_000))],
      totalAnticipo: 0n,
    });
    expect(r.retenciones).toBe(pesos(1_000));
    expect(r.totalFactura).toBe(pesos(118_000));
    expect(r.saldoACargoCliente).toBe(pesos(118_000));
  });

  it("los conceptos sin IVA suman a la base pero no generan IVA", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [],
      conceptos: [conIva(pesos(100_000)), { valor: pesos(41_900), aplicaIva: false }],
      totalAnticipo: 0n,
    });
    expect(r.baseConceptos).toBe(pesos(141_900));
    expect(r.baseIva).toBe(pesos(100_000));
    expect(r.iva).toBe(pesos(19_000));
  });
});

describe("D-1 corregida por evidencia: facturas REALES de Siigo 2026 (tolerancia 0 centavos)", () => {
  it("precisiones: IVA y ReteIVA al CENTAVO; 4x1000 de la factura al PESO", () => {
    expect(PRECISION_IVA).toBe("CENTAVO");
    expect(PRECISION_RETEIVA).toBe("CENTAVO");
    expect(PRECISION_4X1000_FACTURA).toBe("PESO");
  });

  it("FV-2-18702: base 6.632.007 → IVA 1.260.081,33; ReteIVA 231.938,90; total 10.209.744,43", () => {
    expect(ivaDeItem(pesos(6_632_007), 19n)).toBe($("1.260.081,33"));
    const r = calcularFacturaConceptos({
      ...BASE,
      // En esta factura el 4x1000 (3.017) lo escribió Camila a mano sobre otra
      // base; se deja fuera del motor (tasa 0) y se suma el valor real de Siigo.
      terceros: [pesos(754_200)],
      tasa4x1000: 0n,
      totalAnticipo: 0n,
      conceptos: [
        conIva(pesos(6_632_007)),
        conIva(pesos(250_000)),
        conIva(pesos(300_000)),
        conIva(pesos(754_200)),
        conIva(pesos(40_000)),
        conIva(pesos(22_000)),
        conIva(pesos(40_000)),
        conIva(pesos(100_000)),
      ],
    });
    expect(r.iva).toBe($("1.546.259,33"));
    expect(r.retenciones).toBe($("231.938,90")); // 15 % de 1.546.259,33 = 231.938,8995
    expect(r.totalFactura + pesos(3_017)).toBe($("10.209.744,43"));
  });

  it("FV-2-18772: IVA 208.050 → ReteIVA 31.207,50; 4x1000 6.174 al peso; total 2.821.466,50", () => {
    expect(reteIvaSobre(pesos(208_050), 15)).toBe($("31.207,50"));
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [pesos(1_155_000), pesos(262_750), pesos(125_700)],
      conceptos: [
        conIva(pesos(500_000)),
        conIva(pesos(355_000)),
        conIva(pesos(20_000)),
        conIva(pesos(20_000)),
        conIva(pesos(200_000)),
      ],
      totalAnticipo: 0n,
    });
    expect(r.impuesto4x1000).toBe(pesos(6_174)); // 6.173,80 → 6.174 (al peso)
    expect(r.iva).toBe(pesos(208_050));
    expect(r.retenciones).toBe($("31.207,50"));
    expect(r.totalFactura).toBe($("2.821.466,50"));
    expect(r.saldoACargoCliente).toBe($("2.821.466,50"));
  });

  it("BAQ-18385 sigue exacto con D-1 al centavo (conceptos redondos: IVA 64.600, ReteIVA 9.690)", () => {
    const r = calcularFacturaConceptos({
      ...BASE,
      terceros: [$("502.801,45"), pesos(99_484), pesos(486_075)],
      conceptos: [conIva(pesos(200_000)), conIva(pesos(20_000)), conIva(pesos(20_000)), conIva(pesos(100_000))],
      totalAnticipo: pesos(1_418_000),
    });
    expect(r.iva).toBe(pesos(64_600));
    expect(r.retenciones).toBe(pesos(9_690));
    expect(r.totalFactura).toBe($("1.487.623,45"));
    expect(r.saldoACargoCliente).toBe($("69.623,45"));
  });
});

describe("redondeos (diseño A.6; frontera x,5 exacta)", () => {
  it("4x1000 redondea al peso, la mitad hacia arriba", () => {
    expect(impuesto4x1000SobreTerceros(pesos(1_088_360), 400n)).toBe(pesos(4_353)); // 4.353,44
    expect(impuesto4x1000SobreTerceros($("1.088.360,45"), 400n)).toBe(pesos(4_353)); // 4.353,4418
    expect(impuesto4x1000SobreTerceros(pesos(1_125), 400n)).toBe(pesos(5)); // 4,50 exacto → 5
    expect(impuesto4x1000SobreTerceros(112_499n, 400n)).toBe(pesos(4)); // 4,49996 → 4
    expect(impuesto4x1000SobreTerceros(pesos(32_521_912), 400n)).toBe(pesos(130_088)); // BAQ-18453
    expect(impuesto4x1000SobreTerceros(0n, 400n)).toBe(0n);
  });

  it("IVA y ReteIVA al CENTAVO, mitad hacia arriba (D-1)", () => {
    expect(ivaDeItem(pesos(20_000), 19n)).toBe(pesos(3_800));
    expect(ivaDeItem(pesos(12_345), 19n)).toBe($("2.345,55")); // exacto
    expect(ivaDeItem(pesos(50), 19n)).toBe($("9,50")); // exacto, ya no sube a 10
    expect(ivaDeItem(4_999n, 19n)).toBe($("9,50")); // 49,99 × 19 % = 9,4981 → 9,50
    expect(ivaDeItem($("12.345,67"), 19n)).toBe($("2.345,68")); // 2.345,6773 → 2.345,68
    expect(ivaDeItem(1n, 19n)).toBe(0n); // 0,19 centavos → 0
    expect(ivaDeItem(3n, 19n)).toBe(1n); // 0,57 centavos → 1 (mitad arriba)
    expect(reteIvaSobre(pesos(64_600), 15)).toBe(pesos(9_690));
    expect(reteIvaSobre(pesos(10), 15)).toBe($("1,50")); // exacto, ya no sube a 2
    expect(reteIvaSobre($("1.546.259,33"), 15)).toBe($("231.938,90")); // 231.938,8995
    expect(reteIvaSobre(10n, 15)).toBe(2n); // 1,5 centavos → 2 (mitad arriba)
  });

  it("un porcentaje de ReteIVA no entero lanza (nunca se redondea la tasa en silencio)", () => {
    expect(() => reteIvaSobre(pesos(64_600), 15.5)).toThrow();
  });
});
