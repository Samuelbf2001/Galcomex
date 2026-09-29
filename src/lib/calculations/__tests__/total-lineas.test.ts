import { describe, expect, it } from "vitest";
import { pesos } from "@/lib/dinero";

import {
  calcularSaldosPorLineas,
  calcularTotalPorLineas,
} from "@/lib/calculations/total-lineas";

/**
 * Casos dorados del flujo de Lucho (tolerancia 0 pesos).
 * Fuente: PLAN-FLUJO-LUCHO.md §2 y los dos .xls reales.
 * El 4x1000 va DENTRO de las líneas de terceros (no se suma aparte).
 */
describe("calcularTotalPorLineas — casos dorados Lucho", () => {
  it("BAQ-18453: total 33.128.000 y saldo a favor 1.946.500", () => {
    const input = {
      // Σ terceros 32.652.000 (incl. 4x1000 130.088) — una línea agregada.
      lineas: [{ valor: pesos(32_652_000) }],
      comision: pesos(400_000),
      ivaComision: pesos(76_000),
      retenciones: 0n,
    };

    expect(calcularTotalPorLineas(input)).toBe(pesos(33_128_000));

    const saldos = calcularSaldosPorLineas({ ...input, totalAnticipo: pesos(35_074_500) });
    expect(saldos.totalFactura).toBe(pesos(33_128_000));
    expect(saldos.saldoAFavorCliente).toBe(pesos(1_946_500));
    expect(saldos.saldoACargoCliente).toBe(0n);
  });

  it("BAQ-18512: total 1.322.230 (con reteIVA 3.990) y saldo a favor 249.770", () => {
    const input = {
      // Σ terceros 1.159.620 (incl. 4x1000 4.620).
      lineas: [{ valor: pesos(1_159_620) }],
      comision: pesos(140_000), // operacionales
      ivaComision: pesos(26_600),
      retenciones: pesos(3_990), // RETE IVA
    };

    expect(calcularTotalPorLineas(input)).toBe(pesos(1_322_230));

    const saldos = calcularSaldosPorLineas({ ...input, totalAnticipo: pesos(1_572_000) });
    expect(saldos.totalFactura).toBe(pesos(1_322_230));
    expect(saldos.saldoAFavorCliente).toBe(pesos(249_770));
  });

  it("suma varias líneas igual que una agregada (asociatividad BigInt)", () => {
    const total = calcularTotalPorLineas({
      lineas: [{ valor: pesos(12_000_000) }, { valor: pesos(20_522_000) }, { valor: pesos(130_000) }],
      comision: pesos(400_000),
      ivaComision: pesos(76_000),
      retenciones: 0n,
    });
    expect(total).toBe(pesos(12_000_000) + pesos(20_522_000) + pesos(130_000) + pesos(400_000) + pesos(76_000));
  });

  it("saldo a cargo del cliente cuando el total supera el anticipo", () => {
    const saldos = calcularSaldosPorLineas({
      lineas: [{ valor: pesos(2_000_000) }],
      comision: pesos(150_000),
      ivaComision: pesos(28_500),
      retenciones: 0n,
      totalAnticipo: pesos(1_000_000),
    });
    expect(saldos.saldoACargoCliente).toBe(pesos(1_178_500));
    expect(saldos.saldoAFavorCliente).toBe(0n);
  });

  it("split montoLM: a favor, el cliente recupera saldo − montoLM", () => {
    const saldos = calcularSaldosPorLineas({
      lineas: [{ valor: pesos(1_000_000) }],
      comision: 0n,
      ivaComision: 0n,
      retenciones: 0n,
      totalAnticipo: pesos(5_000_000),
      montoLM: pesos(500_000),
    });
    // total = 1.000.000; saldoFinal = 4.000.000; cliente = 3.500.000; LM = 500.000
    expect(saldos.totalFactura).toBe(pesos(1_000_000));
    expect(saldos.saldoAFavorCliente).toBe(pesos(3_500_000));
    expect(saldos.saldoAFavorLM).toBe(pesos(500_000));
  });
});

/**
 * Casos dorados extraídos de la hoja `RELACION FACT 2026` del Excel
 * `GRUPO E PAPIS 2026.xlsm`. Cada trámite se modela como una sola línea
 * agregada de TERCEROS (la suma efectiva incluye 4x1000 y costos bancarios)
 * + la comisión y el IVA propio del borrador. El cruce con el cliente sale de
 * `anticipo − TOTAL FACTURA`, NO de Σ pagos.
 *
 * Tolerancia 0 pesos.
 */
describe("calcularSaldosPorLineas — cruce real contra trámites Galcomex 2026", () => {
  it("DO.BUN26-0026 (BAQ-18288): saldo a favor 3.357.958", () => {
    // Σ líneas = 41.868.042 − 200.000 (comisión) − 76.000 (IVA override Excel)
    const input = {
      lineas: [{ valor: pesos(41_592_042) }],
      comision: pesos(200_000),
      ivaComision: pesos(76_000),
      retenciones: 0n,
      totalAnticipo: pesos(45_226_000),
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(pesos(41_868_042));
    expect(saldos.saldoAFavorCliente).toBe(pesos(3_357_958));
    expect(saldos.saldoACargoCliente).toBe(0n);
  });

  it("DO.CTG26-0090 (BAQ-18413): saldo a cargo 2.196.953", () => {
    // Σ líneas = 34.119.133 − 150.000 − 76.000
    const input = {
      lineas: [{ valor: pesos(33_893_133) }],
      comision: pesos(150_000),
      ivaComision: pesos(76_000),
      retenciones: 0n,
      totalAnticipo: pesos(31_922_180),
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(pesos(34_119_133));
    expect(saldos.saldoACargoCliente).toBe(pesos(2_196_953));
    expect(saldos.saldoAFavorCliente).toBe(0n);
  });

  it("DO.CTG26-0063 (BAQ-18358): saldo a cargo 2.956.282", () => {
    // Σ líneas = 30.722.282 − 150.000 − 76.000
    const input = {
      lineas: [{ valor: pesos(30_496_282) }],
      comision: pesos(150_000),
      ivaComision: pesos(76_000),
      retenciones: 0n,
      totalAnticipo: pesos(27_766_000),
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(pesos(30_722_282));
    expect(saldos.saldoACargoCliente).toBe(pesos(2_956_282));
    expect(saldos.saldoAFavorCliente).toBe(0n);
  });

  it("DO.CTG26-0118 (BAQ-18453): cruce GRUPO E PAPIS coincide con flujo socio", () => {
    // Mismo total/saldo que el caso BAQ-18453 del flujo Lucho, validando que
    // la fórmula del cruce es independiente del split comisión vs líneas.
    const input = {
      lineas: [{ valor: pesos(32_902_000) }],
      comision: pesos(150_000),
      ivaComision: pesos(76_000),
      retenciones: 0n,
      totalAnticipo: pesos(35_074_500),
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(pesos(33_128_000));
    expect(saldos.saldoAFavorCliente).toBe(pesos(1_946_500));
  });
});
