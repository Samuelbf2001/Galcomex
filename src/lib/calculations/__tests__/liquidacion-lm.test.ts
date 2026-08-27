import { describe, expect, it } from "vitest";

import { agregarLiquidacionLM } from "@/lib/calculations/liquidacion-lm";

describe("liquidacion-lm — agregación por lotes", () => {
  it("netea saldos mixtos y separa quién debe a quién", () => {
    const { resumen } = agregarLiquidacionLM([
      { saldoLM: -179_734n }, // Lucho debe (BAQ-18453)
      { saldoLM: 300_000n }, //  Galcomex debe
      { saldoLM: 0n }, //        saldado
    ]);

    expect(resumen.saldoNeto).toBe(120_266n); // −179.734 + 300.000 + 0
    expect(resumen.totalLuchoDebe).toBe(179_734n);
    expect(resumen.totalGalcomexDebe).toBe(300_000n);
    expect(resumen.cantidad).toBe(3);
  });

  it("lista vacía → resumen en ceros", () => {
    const { items, resumen } = agregarLiquidacionLM([]);
    expect(items).toEqual([]);
    expect(resumen).toEqual({
      saldoNeto: 0n,
      totalLuchoDebe: 0n,
      totalGalcomexDebe: 0n,
      cantidad: 0,
    });
  });

  it("preserva los campos extra de cada item (spread)", () => {
    const { items } = agregarLiquidacionLM([
      { consecutivo: "DO.CTG26-0118", saldoLM: -179_734n },
    ]);
    expect(items[0].consecutivo).toBe("DO.CTG26-0118");
    expect(items[0].saldoLM).toBe(-179_734n);
  });
});
