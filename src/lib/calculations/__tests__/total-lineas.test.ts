import { describe, expect, it } from "vitest";

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
      lineas: [{ valor: 32_652_000n }],
      comision: 400_000n,
      ivaComision: 76_000n,
      retenciones: 0n,
    };

    expect(calcularTotalPorLineas(input)).toBe(33_128_000n);

    const saldos = calcularSaldosPorLineas({ ...input, totalAnticipo: 35_074_500n });
    expect(saldos.totalFactura).toBe(33_128_000n);
    expect(saldos.saldoAFavorCliente).toBe(1_946_500n);
    expect(saldos.saldoACargoCliente).toBe(0n);
  });

  it("BAQ-18512: total 1.322.230 (con reteIVA 3.990) y saldo a favor 249.770", () => {
    const input = {
      // Σ terceros 1.159.620 (incl. 4x1000 4.620).
      lineas: [{ valor: 1_159_620n }],
      comision: 140_000n, // operacionales
      ivaComision: 26_600n,
      retenciones: 3_990n, // RETE IVA
    };

    expect(calcularTotalPorLineas(input)).toBe(1_322_230n);

    const saldos = calcularSaldosPorLineas({ ...input, totalAnticipo: 1_572_000n });
    expect(saldos.totalFactura).toBe(1_322_230n);
    expect(saldos.saldoAFavorCliente).toBe(249_770n);
  });

  it("suma varias líneas igual que una agregada (asociatividad BigInt)", () => {
    const total = calcularTotalPorLineas({
      lineas: [{ valor: 12_000_000n }, { valor: 20_522_000n }, { valor: 130_000n }],
      comision: 400_000n,
      ivaComision: 76_000n,
      retenciones: 0n,
    });
    expect(total).toBe(12_000_000n + 20_522_000n + 130_000n + 400_000n + 76_000n);
  });

  it("saldo a cargo del cliente cuando el total supera el anticipo", () => {
    const saldos = calcularSaldosPorLineas({
      lineas: [{ valor: 2_000_000n }],
      comision: 150_000n,
      ivaComision: 28_500n,
      retenciones: 0n,
      totalAnticipo: 1_000_000n,
    });
    expect(saldos.saldoACargoCliente).toBe(1_178_500n);
    expect(saldos.saldoAFavorCliente).toBe(0n);
  });

  it("split montoLM: a favor, el cliente recupera saldo − montoLM", () => {
    const saldos = calcularSaldosPorLineas({
      lineas: [{ valor: 1_000_000n }],
      comision: 0n,
      ivaComision: 0n,
      retenciones: 0n,
      totalAnticipo: 5_000_000n,
      montoLM: 500_000n,
    });
    // total = 1.000.000; saldoFinal = 4.000.000; cliente = 3.500.000; LM = 500.000
    expect(saldos.totalFactura).toBe(1_000_000n);
    expect(saldos.saldoAFavorCliente).toBe(3_500_000n);
    expect(saldos.saldoAFavorLM).toBe(500_000n);
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
      lineas: [{ valor: 41_592_042n }],
      comision: 200_000n,
      ivaComision: 76_000n,
      retenciones: 0n,
      totalAnticipo: 45_226_000n,
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(41_868_042n);
    expect(saldos.saldoAFavorCliente).toBe(3_357_958n);
    expect(saldos.saldoACargoCliente).toBe(0n);
  });

  it("DO.CTG26-0090 (BAQ-18413): saldo a cargo 2.196.953", () => {
    // Σ líneas = 34.119.133 − 150.000 − 76.000
    const input = {
      lineas: [{ valor: 33_893_133n }],
      comision: 150_000n,
      ivaComision: 76_000n,
      retenciones: 0n,
      totalAnticipo: 31_922_180n,
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(34_119_133n);
    expect(saldos.saldoACargoCliente).toBe(2_196_953n);
    expect(saldos.saldoAFavorCliente).toBe(0n);
  });

  it("DO.CTG26-0063 (BAQ-18358): saldo a cargo 2.956.282", () => {
    // Σ líneas = 30.722.282 − 150.000 − 76.000
    const input = {
      lineas: [{ valor: 30_496_282n }],
      comision: 150_000n,
      ivaComision: 76_000n,
      retenciones: 0n,
      totalAnticipo: 27_766_000n,
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(30_722_282n);
    expect(saldos.saldoACargoCliente).toBe(2_956_282n);
    expect(saldos.saldoAFavorCliente).toBe(0n);
  });

  it("DO.CTG26-0118 (BAQ-18453): cruce GRUPO E PAPIS coincide con flujo socio", () => {
    // Mismo total/saldo que el caso BAQ-18453 del flujo Lucho, validando que
    // la fórmula del cruce es independiente del split comisión vs líneas.
    const input = {
      lineas: [{ valor: 32_902_000n }],
      comision: 150_000n,
      ivaComision: 76_000n,
      retenciones: 0n,
      totalAnticipo: 35_074_500n,
    };

    const saldos = calcularSaldosPorLineas(input);
    expect(saldos.totalFactura).toBe(33_128_000n);
    expect(saldos.saldoAFavorCliente).toBe(1_946_500n);
  });
});
