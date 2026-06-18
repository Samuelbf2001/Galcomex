import { describe, it, expect } from "vitest";
import { calcularBorrador, calcularSaldosIntermedios } from "../motor-factura";

// Parámetros del sistema (igual que el seed)
const TASA_IVA = 19n;
const TASA_4X1000 = 400n; // 400 / 100_000 = 0.004

// ---------------------------------------------------------------------------
// TEST DORADO — DO.BUN26-0026 (datos reales del Excel GRUPO E PAPIS 2026)
// Hoja: BUN26-0026. Tolerancia: 0 pesos.
//
// Inputs:
//   Anticipo total aplicado:          45.226.000
//   Costo recaudo anticipo (BANCOLOMBIA OTRO): 1.950
//   7 pagos (valor, canal, costo):
//     1. 1.000.000   TRANSF BANCOLOMBIA  3.900
//     2. 2.011.341   PSE                 0
//     3. 30.854.000  PSE                 0
//     4. 2.216.233   PSE                 0
//     5. 760.283     TRANSF BANCOLOMBIA  3.900
//     6. 175.787     TRANSF BANCOLOMBIA  3.900
//     7. 3.500.000   TRANSF BANCOLOMBIA  3.900
//   Comisión Galcomex:                200.000
//   IVA comisión (override manual):   76.000   ← celda manual en Excel, NO 19%×comisión
//   Monto LM:                         875.944
//
// Valores esperados (tolerancia 0):
//   totalPagos         = 40.517.644
//   costosBancarios    = 17.550   (1.950 + 4×3.900)
//   saldoTrasPagos     = 4.708.356
//   impuesto4x1000     = 180.904  (45.226.000 × 0.004)
//   saldoFinal         = 4.233.902
//   totalFactura       = 41.868.042
//   saldoAFavorCliente = 3.357.958
//   saldoAFavorLM      = 875.944
// ---------------------------------------------------------------------------
describe("TEST DORADO — DO.BUN26-0026", () => {
  const PAGOS_DORADO = [
    { valor: 1_000_000n, costoBancario: 3_900n },   // TRANSF BANCOLOMBIA
    { valor: 2_011_341n, costoBancario: 0n },        // PSE
    { valor: 30_854_000n, costoBancario: 0n },       // PSE
    { valor: 2_216_233n, costoBancario: 0n },        // PSE
    { valor: 760_283n, costoBancario: 3_900n },      // TRANSF BANCOLOMBIA
    { valor: 175_787n, costoBancario: 3_900n },      // TRANSF BANCOLOMBIA
    { valor: 3_500_000n, costoBancario: 3_900n },    // TRANSF BANCOLOMBIA
  ];

  const INPUT_DORADO = {
    totalAnticipoAplicado: 45_226_000n,
    costoRecaudoAnticipo: 1_950n,       // costo bancario del recaudo del anticipo
    pagos: PAGOS_DORADO,
    comision: 200_000n,
    ivaComision: 76_000n,               // override manual del Excel (no 19%×200.000)
    tasaIva: TASA_IVA,
    tasa4x1000: TASA_4X1000,
    montoLM: 875_944n,
  };

  it("totalPagos === 40.517.644", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.totalPagos).toBe(40_517_644n);
  });

  it("costosBancarios === 17.550 (1.950 recaudo + 4×3.900 pagos)", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.costosBancarios).toBe(17_550n);
  });

  it("saldoTrasPagos === 4.708.356", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.saldoTrasPagos).toBe(4_708_356n);
  });

  it("aplica4x1000 === true (saldo a favor)", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.aplica4x1000).toBe(true);
  });

  it("impuesto4x1000 === 180.904 (45.226.000 × 0.004)", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.impuesto4x1000).toBe(180_904n);
  });

  it("saldoFinal === 4.233.902", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.saldoFinal).toBe(4_233_902n);
  });

  it("totalFactura === 41.868.042", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.totalFactura).toBe(41_868_042n);
  });

  it("saldoAFavorCliente === 3.357.958", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.saldoAFavorCliente).toBe(3_357_958n);
  });

  it("saldoACargoCliente === 0 (es a favor)", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.saldoACargoCliente).toBe(0n);
  });

  it("saldoAFavorLM === 875.944", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.saldoAFavorLM).toBe(875_944n);
  });

  it("saldoACargoLM === 0 (es a favor)", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.saldoACargoLM).toBe(0n);
  });

  it("ivaComision === 76.000 (override manual respetado)", () => {
    const r = calcularBorrador(INPUT_DORADO);
    expect(r.ivaComision).toBe(76_000n);
  });
});

// ---------------------------------------------------------------------------
// RAMA SALDO A CARGO
// Caso: anticipo insuficiente → pagos + deducciones > anticipo → cliente debe.
// Regla: el 4x1000 SIEMPRE se cobra; cuando queda a cargo, base = anticipo + |saldo a cargo|.
// ---------------------------------------------------------------------------
describe("Rama saldo a cargo del cliente", () => {
  it("saldoACargoCliente > 0, saldoAFavorCliente === 0, aplica4x1000 === false", () => {
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 1_000_000n,
      pagos: [
        { valor: 900_000n, costoBancario: 3_900n },
        { valor: 200_000n, costoBancario: 0n },
      ],
      comision: 150_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });

    // saldoTrasPagos = 1.000.000 − 1.100.000 = −100.000
    expect(resultado.saldoTrasPagos).toBe(-100_000n);
    // saldoAntesDe4x1000 = −100.000 − 150.000 − 28.500 − 3.900 = −282.400 (a cargo)
    // 4x1000 SIEMPRE se cobra: base = anticipo + |saldo a cargo| = 1.000.000 + 282.400 = 1.282.400
    // impuesto4x1000 = 1.282.400 × 0,004 = 5.129 (trunc) → saldoFinal = −282.400 − 5.129 = −287.529
    expect(resultado.aplica4x1000).toBe(false);
    expect(resultado.impuesto4x1000).toBe(5_129n);
    expect(resultado.saldoFinal).toBe(-287_529n);
    expect(resultado.saldoACargoCliente).toBeGreaterThan(0n);
    expect(resultado.saldoAFavorCliente).toBe(0n);
  });

  it("caso a cargo exacto: verifica saldoACargoCliente === |saldoFinal|", () => {
    // anticipo 500.000, pago 600.000, sin comisión extra
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 500_000n,
      pagos: [{ valor: 600_000n, costoBancario: 0n }],
      comision: 0n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });

    // saldoAntesDe4x1000 = 500.000 − 600.000 = −100.000 (a cargo)
    // 4x1000: base = 500.000 + 100.000 = 600.000 → 600.000 × 0,004 = 2.400
    // saldoFinal = −100.000 − 2.400 = −102.400
    expect(resultado.saldoFinal).toBe(-102_400n);
    expect(resultado.saldoACargoCliente).toBe(102_400n);
    expect(resultado.saldoAFavorCliente).toBe(0n);
    expect(resultado.aplica4x1000).toBe(false);
  });

  it("caso a cargo con montoLM > 0: saldoACargoLM === montoLM", () => {
    // Cuando el saldo queda a cargo del cliente y hay montoLM,
    // saldoACargoLM debe ser el montoLM (rama `montoLM > 0n` de línea 149)
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 500_000n,
      pagos: [{ valor: 600_000n, costoBancario: 0n }],
      comision: 0n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
      montoLM: 50_000n,
    });

    expect(resultado.saldoACargoCliente).toBeGreaterThan(0n);
    expect(resultado.saldoAFavorCliente).toBe(0n);
    expect(resultado.saldoACargoLM).toBe(50_000n);
    expect(resultado.saldoAFavorLM).toBe(0n);
    expect(resultado.aplica4x1000).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IVA OVERRIDE vs DEFAULT
// ---------------------------------------------------------------------------
describe("IVA comisión: override explícito vs. default calculado", () => {
  it("sin ivaComision → usa comision * tasaIva / 100n", () => {
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 200_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    // 200.000 × 19 / 100 = 38.000
    expect(resultado.ivaComision).toBe(38_000n);
  });

  it("con ivaComision override → usa el valor dado exacto", () => {
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 200_000n,
      ivaComision: 76_000n,  // override manual, como en el Excel
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    expect(resultado.ivaComision).toBe(76_000n);
  });

  it("ivaComision override afecta saldoFinal (76.000 vs 38.000)", () => {
    const base = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 200_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    const conOverride = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 200_000n,
      ivaComision: 76_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    // saldoFinal con override tiene 38.000 más de IVA → menor saldoFinal
    expect(conOverride.saldoFinal).toBe(base.saldoFinal - 38_000n);
  });
});

// ---------------------------------------------------------------------------
// DETERMINISMO
// ---------------------------------------------------------------------------
describe("Determinismo", () => {
  it("mismo input dos veces → mismo output exacto", () => {
    const input = {
      totalAnticipoAplicado: 45_226_000n,
      costoRecaudoAnticipo: 1_950n,
      pagos: [
        { valor: 1_000_000n, costoBancario: 3_900n },
        { valor: 2_011_341n, costoBancario: 0n },
        { valor: 30_854_000n, costoBancario: 0n },
        { valor: 2_216_233n, costoBancario: 0n },
        { valor: 760_283n, costoBancario: 3_900n },
        { valor: 175_787n, costoBancario: 3_900n },
        { valor: 3_500_000n, costoBancario: 3_900n },
      ],
      comision: 200_000n,
      ivaComision: 76_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
      montoLM: 875_944n,
    };

    const r1 = calcularBorrador(input);
    const r2 = calcularBorrador(input);

    expect(r1.totalPagos).toBe(r2.totalPagos);
    expect(r1.costosBancarios).toBe(r2.costosBancarios);
    expect(r1.saldoTrasPagos).toBe(r2.saldoTrasPagos);
    expect(r1.impuesto4x1000).toBe(r2.impuesto4x1000);
    expect(r1.saldoFinal).toBe(r2.saldoFinal);
    expect(r1.totalFactura).toBe(r2.totalFactura);
    expect(r1.saldoAFavorCliente).toBe(r2.saldoAFavorCliente);
    expect(r1.saldoAFavorLM).toBe(r2.saldoAFavorLM);
  });
});

// ---------------------------------------------------------------------------
// CASOS BORDE
// ---------------------------------------------------------------------------
describe("Casos borde", () => {
  it("sin anticipo y sin pagos: saldo 0, no aplica 4x1000", () => {
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 0n,
      pagos: [],
      comision: 150_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });

    expect(resultado.aplica4x1000).toBe(false);
    expect(resultado.impuesto4x1000).toBe(0n);
    expect(resultado.totalPagos).toBe(0n);
    expect(resultado.costosBancarios).toBe(0n);
  });

  it("anticipo cubre exacto comisión+IVA: el 4x1000 (siempre cobrado) deja un pequeño saldo a cargo", () => {
    // comision=150.000, ivaComision=28.500 (default), sin pagos
    // saldoAntesDe4x1000 = anticipo − comision − iva = 0 (límite a favor)
    const comision = 150_000n;
    const ivaDefault = (comision * TASA_IVA) / 100n; // 28.500
    const anticipo = comision + ivaDefault; // 178.500

    const resultado = calcularBorrador({
      totalAnticipoAplicado: anticipo,
      pagos: [],
      comision,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });

    // 4x1000 = anticipo × 0,004 = 178.500 × 0,004 = 714 → saldoFinal = 0 − 714 = −714
    expect(resultado.aplica4x1000).toBe(true);
    expect(resultado.impuesto4x1000).toBe(714n);
    expect(resultado.saldoFinal).toBe(-714n);
    expect(resultado.saldoAFavorCliente).toBe(0n);
    expect(resultado.saldoACargoCliente).toBe(714n);
  });

  it("comisión editada manualmente: el IVA default cambia en cascada", () => {
    const base = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 150_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    const editada = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 200_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });

    // IVA 150.000 × 19% = 28.500; IVA 200.000 × 19% = 38.000
    expect(base.ivaComision).toBe(28_500n);
    expect(editada.ivaComision).toBe(38_000n);
    expect(editada.saldoFinal).toBeLessThan(base.saldoFinal);
  });

  it("costoRecaudoAnticipo default 0: sin él, misma lógica que antes", () => {
    const sinCosto = calcularBorrador({
      totalAnticipoAplicado: 5_000_000n,
      pagos: [{ valor: 1_000_000n, costoBancario: 3_900n }],
      comision: 100_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    const conCeroExplicito = calcularBorrador({
      totalAnticipoAplicado: 5_000_000n,
      costoRecaudoAnticipo: 0n,
      pagos: [{ valor: 1_000_000n, costoBancario: 3_900n }],
      comision: 100_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    expect(sinCosto.costosBancarios).toBe(conCeroExplicito.costosBancarios);
    expect(sinCosto.saldoFinal).toBe(conCeroExplicito.saldoFinal);
  });

  it("montoLM default 0: sin LM el saldoAFavorCliente === saldoFinal (cuando a favor)", () => {
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      pagos: [],
      comision: 150_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    expect(resultado.saldoAFavorLM).toBe(0n);
    expect(resultado.saldoAFavorCliente).toBe(resultado.saldoFinal);
  });

  it("sin pagos ni costos: costosBancarios === costoRecaudoAnticipo solo", () => {
    const resultado = calcularBorrador({
      totalAnticipoAplicado: 10_000_000n,
      costoRecaudoAnticipo: 1_950n,
      pagos: [],
      comision: 0n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    });
    expect(resultado.costosBancarios).toBe(1_950n);
  });
});

// ---------------------------------------------------------------------------
// TEST DORADO NUEVO — BAQ-18453 (GRUPO E PAPIS / LUTOSA, DO.CTG26-0118)
// Fuente: excel-lucho-1.xls (hoja "Hoja1")
//
// MAPEO DE CELDAS AL MOTOR:
//   - pagos = líneas de "INGRESOS RECIBIDOS PARA TERCEROS" (incl. línea 4x1000 = 130.088)
//     Todos los pagos de Lucho son PSE o transferencia. Como el 4x1000 está embebido
//     en el total de terceros como una línea más del libro, tasa4x1000=0n (no se cobra
//     adicionalmente por el motor).
//   - Para simplificar el test usamos un único pago con el total de terceros (el test
//     de integración real usaría las líneas individuales).
//   - costosBancarios = 0n (PSE = 0 costo; en Lucho los pagos vía PSE son directos).
//   - comision = 400.000 (ingresos operacionales del Excel).
//   - ivaComision = 76.000 (override manual, celda del Excel).
//   - retenciones = 0n.
//   - anticipo = 35.074.500.
//
// Valores esperados (tolerancia 0 pesos):
//   totalPagos         = 32.652.000
//   saldoTrasPagos     = 2.422.500
//   aplica4x1000       = false (tasa=0n)
//   impuesto4x1000     = 0
//   saldoFinal         = 1.946.500
//   totalFactura       = 33.128.000
//   saldoAFavorCliente = 1.946.500
// ---------------------------------------------------------------------------
describe("TEST DORADO NUEVO — BAQ-18453 (excel-lucho-1.xls)", () => {
  const INPUT_BAQ18453 = {
    totalAnticipoAplicado: 35_074_500n,
    costoRecaudoAnticipo: 0n,
    pagos: [
      // Total terceros 32.652.000 (incl. 4x1000 130.088 como línea del libro)
      { valor: 32_652_000n, costoBancario: 0n },
    ],
    comision: 400_000n,
    ivaComision: 76_000n,          // override manual del Excel
    tasaIva: TASA_IVA,
    tasa4x1000: 0n,                // 4x1000 ya está dentro de pagos — no cobrar 2 veces
    montoLM: 0n,
    retenciones: 0n,
  };

  it("totalPagos === 32.652.000", () => {
    expect(calcularBorrador(INPUT_BAQ18453).totalPagos).toBe(32_652_000n);
  });

  it("saldoTrasPagos === 2.422.500", () => {
    expect(calcularBorrador(INPUT_BAQ18453).saldoTrasPagos).toBe(2_422_500n);
  });

  it("aplica4x1000 === true (saldo positivo) pero impuesto4x1000 === 0 (tasa=0n, 4x1000 embebido en pagos)", () => {
    const r = calcularBorrador(INPUT_BAQ18453);
    // aplica4x1000=true porque saldoAntesDe4x1000 > 0, pero con tasa=0n → impuesto=0
    expect(r.aplica4x1000).toBe(true);
    expect(r.impuesto4x1000).toBe(0n);
  });

  it("impuesto4x1000 === 0", () => {
    expect(calcularBorrador(INPUT_BAQ18453).impuesto4x1000).toBe(0n);
  });

  it("saldoFinal === 1.946.500", () => {
    expect(calcularBorrador(INPUT_BAQ18453).saldoFinal).toBe(1_946_500n);
  });

  it("totalFactura === 33.128.000", () => {
    expect(calcularBorrador(INPUT_BAQ18453).totalFactura).toBe(33_128_000n);
  });

  it("saldoAFavorCliente === 1.946.500", () => {
    expect(calcularBorrador(INPUT_BAQ18453).saldoAFavorCliente).toBe(1_946_500n);
  });

  it("retenciones === 0 en el output", () => {
    expect(calcularBorrador(INPUT_BAQ18453).retenciones).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// TEST DORADO NUEVO — BAQ-18512 (LITOPLAS / OPP FILM, DO.26-0113)
// Fuente: excel-lucho-2.xls (hoja "Hoja1")
//
// MAPEO DE CELDAS AL MOTOR:
//   - pagos = líneas "INGRESOS RECIBIDOS PARA TERCEROS" (incl. 4x1000 4.620):
//     total 1.159.620.
//   - comision = 140.000 (REVISION DOCUMENTOS 20.000 + SISTEMATIZACION 20.000
//     + LOGISTICA OPERATIVA 100.000 = 140.000).
//   - ivaComision = 26.600 (19% × 140.000, override manual en el Excel).
//   - RETE IVA = 0,15 × 26.600 = 3.990 → retenciones = 3.990n.
//   - tasa4x1000 = 0n (4x1000 = 4.620 ya dentro de pagos).
//   - costosBancarios = 0n (pagos PSE directos por Lucho).
//   - anticipo = 1.572.000.
//
// Valores esperados (tolerancia 0 pesos):
//   totalPagos         = 1.159.620
//   saldoTrasPagos     = 412.380
//   saldoFinal         = 245.780
//   retenciones        = 3.990
//   saldoAFavorCliente = 249.770   (saldoFinal + retenciones)
//   totalFactura       = 1.322.230 (anticipo − saldoAFavorCliente)
// ---------------------------------------------------------------------------
describe("TEST DORADO NUEVO — BAQ-18512 (excel-lucho-2.xls, con retenciones)", () => {
  const INPUT_BAQ18512 = {
    totalAnticipoAplicado: 1_572_000n,
    costoRecaudoAnticipo: 0n,
    pagos: [
      // Total terceros 1.159.620 (incl. 4x1000 4.620 como línea del libro)
      { valor: 1_159_620n, costoBancario: 0n },
    ],
    comision: 140_000n,
    ivaComision: 26_600n,          // 19% × 140.000, override manual del Excel
    tasaIva: TASA_IVA,
    tasa4x1000: 0n,                // 4x1000 ya dentro de pagos
    montoLM: 0n,
    retenciones: 3_990n,           // RETE IVA 0,15 × 26.600 = 3.990
  };

  it("totalPagos === 1.159.620", () => {
    expect(calcularBorrador(INPUT_BAQ18512).totalPagos).toBe(1_159_620n);
  });

  it("saldoTrasPagos === 412.380", () => {
    expect(calcularBorrador(INPUT_BAQ18512).saldoTrasPagos).toBe(412_380n);
  });

  it("saldoFinal === 245.780 (antes de retenciones)", () => {
    expect(calcularBorrador(INPUT_BAQ18512).saldoFinal).toBe(245_780n);
  });

  it("retenciones === 3.990 en el output", () => {
    expect(calcularBorrador(INPUT_BAQ18512).retenciones).toBe(3_990n);
  });

  it("saldoAFavorCliente === 249.770 (saldoFinal + retenciones)", () => {
    expect(calcularBorrador(INPUT_BAQ18512).saldoAFavorCliente).toBe(249_770n);
  });

  it("totalFactura === 1.322.230 (anticipo − saldoAFavorCliente)", () => {
    expect(calcularBorrador(INPUT_BAQ18512).totalFactura).toBe(1_322_230n);
  });

  it("aplica4x1000 === true (saldo positivo) pero impuesto4x1000 === 0 (tasa=0n)", () => {
    const r = calcularBorrador(INPUT_BAQ18512);
    // aplica4x1000=true porque saldoAntesDe4x1000 > 0, pero con tasa=0n → impuesto=0
    expect(r.aplica4x1000).toBe(true);
    expect(r.impuesto4x1000).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// RETENCIONES = 0n → comportamiento idéntico al anterior (invariante BUN26-0026)
// ---------------------------------------------------------------------------
describe("retenciones=0n produce output idéntico al comportamiento anterior", () => {
  it("retenciones=0n explícito === sin campo retenciones (legacy)", () => {
    const sinRetenciones = calcularBorrador({
      totalAnticipoAplicado: 45_226_000n,
      costoRecaudoAnticipo: 1_950n,
      pagos: [
        { valor: 1_000_000n, costoBancario: 3_900n },
        { valor: 2_011_341n, costoBancario: 0n },
        { valor: 30_854_000n, costoBancario: 0n },
        { valor: 2_216_233n, costoBancario: 0n },
        { valor: 760_283n, costoBancario: 3_900n },
        { valor: 175_787n, costoBancario: 3_900n },
        { valor: 3_500_000n, costoBancario: 3_900n },
      ],
      comision: 200_000n,
      ivaComision: 76_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
      montoLM: 875_944n,
    });

    const conCeroExplicito = calcularBorrador({
      totalAnticipoAplicado: 45_226_000n,
      costoRecaudoAnticipo: 1_950n,
      pagos: [
        { valor: 1_000_000n, costoBancario: 3_900n },
        { valor: 2_011_341n, costoBancario: 0n },
        { valor: 30_854_000n, costoBancario: 0n },
        { valor: 2_216_233n, costoBancario: 0n },
        { valor: 760_283n, costoBancario: 3_900n },
        { valor: 175_787n, costoBancario: 3_900n },
        { valor: 3_500_000n, costoBancario: 3_900n },
      ],
      comision: 200_000n,
      ivaComision: 76_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
      montoLM: 875_944n,
      retenciones: 0n,
    });

    // Todos los valores deben ser idénticos al caso dorado BUN26-0026
    expect(conCeroExplicito.totalPagos).toBe(sinRetenciones.totalPagos);
    expect(conCeroExplicito.costosBancarios).toBe(sinRetenciones.costosBancarios);
    expect(conCeroExplicito.saldoFinal).toBe(sinRetenciones.saldoFinal);
    expect(conCeroExplicito.totalFactura).toBe(sinRetenciones.totalFactura);
    expect(conCeroExplicito.saldoAFavorCliente).toBe(sinRetenciones.saldoAFavorCliente);
    expect(conCeroExplicito.saldoAFavorLM).toBe(sinRetenciones.saldoAFavorLM);

    // Y cuadran con los valores del caso dorado BUN26-0026
    expect(conCeroExplicito.totalFactura).toBe(41_868_042n);
    expect(conCeroExplicito.saldoAFavorCliente).toBe(3_357_958n);
    expect(conCeroExplicito.saldoAFavorLM).toBe(875_944n);
    expect(conCeroExplicito.retenciones).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// SALDOS INTERMEDIOS (libro de pagos) — firma inmutable para A1-T6
// ---------------------------------------------------------------------------
describe("Saldos intermedios (libro de pagos)", () => {
  it("calcula saldos corrientes línea a línea", () => {
    const saldos = calcularSaldosIntermedios(10_000_000n, [
      { valor: 1_000_000n },
      { valor: 2_000_000n },
      { valor: 3_000_000n },
    ]);

    expect(saldos).toEqual([9_000_000n, 7_000_000n, 4_000_000n]);
  });

  it("sin pagos retorna arreglo vacío", () => {
    expect(calcularSaldosIntermedios(5_000_000n, [])).toEqual([]);
  });

  it("caso dorado DO.BUN26-0026: saldo tras los 7 pagos === 4.708.356", () => {
    const pagos = [
      { valor: 1_000_000n },
      { valor: 2_011_341n },
      { valor: 30_854_000n },
      { valor: 2_216_233n },
      { valor: 760_283n },
      { valor: 175_787n },
      { valor: 3_500_000n },
    ];
    const saldos = calcularSaldosIntermedios(45_226_000n, pagos);
    expect(saldos[saldos.length - 1]).toBe(4_708_356n);
  });
});
