import { describe, expect, it } from "vitest";
import { pesos } from "@/lib/dinero";

import { agregarLiquidacionLM } from "@/lib/calculations/liquidacion-lm";

describe("liquidacion-lm — agregación por lotes", () => {
  it("netea saldos mixtos y separa quién debe a quién", () => {
    const { resumen } = agregarLiquidacionLM([
      { saldoLM: -pesos(179_734) }, // Lucho debe (BAQ-18453)
      { saldoLM: pesos(300_000) }, //  Galcomex debe
      { saldoLM: 0n }, //        saldado
    ]);

    expect(resumen.saldoNeto).toBe(pesos(120_266)); // −179.734 + 300.000 + 0
    expect(resumen.totalLuchoDebe).toBe(pesos(179_734));
    expect(resumen.totalGalcomexDebe).toBe(pesos(300_000));
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
      { consecutivo: "DO.CTG26-0118", saldoLM: -pesos(179_734) },
    ]);
    expect(items[0].consecutivo).toBe("DO.CTG26-0118");
    expect(items[0].saldoLM).toBe(-pesos(179_734));
  });
});
