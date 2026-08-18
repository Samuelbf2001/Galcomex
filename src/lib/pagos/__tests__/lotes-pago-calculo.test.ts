/**
 * Tests unitarios PUROS (sin BD) — lote de pago (reunión 1-jul-2026,
 * 00:48–00:50). Tolerancia 0 pesos: todo en BigInt.
 */
import { describe, expect, it } from "vitest";

import {
  agruparFacturasPorTramite,
  repartirCostoBancario,
  type FacturaLoteItem,
} from "../lotes-pago-calculo";

describe("agruparFacturasPorTramite", () => {
  it("agrupa facturas de un solo trámite en un solo grupo", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "t1", valor: 1_000_000n },
      { facturaProveedorId: "f2", tramiteId: "t1", valor: 500_000n },
    ];

    const grupos = agruparFacturasPorTramite(items);

    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toEqual({
      tramiteId: "t1",
      facturaIds: ["f1", "f2"],
      valor: 1_500_000n,
    });
  });

  it("separa facturas de trámites distintos en grupos distintos (el caso de Karina)", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "t1", valor: 2_000_000n },
      { facturaProveedorId: "f2", tramiteId: "t2", valor: 3_000_000n },
      { facturaProveedorId: "f3", tramiteId: "t1", valor: 1_000_000n },
    ];

    const grupos = agruparFacturasPorTramite(items);

    expect(grupos).toHaveLength(2);
    expect(grupos.map((g) => g.tramiteId)).toEqual(["t1", "t2"]);
    expect(grupos[0]).toEqual({ tramiteId: "t1", facturaIds: ["f1", "f3"], valor: 3_000_000n });
    expect(grupos[1]).toEqual({ tramiteId: "t2", facturaIds: ["f2"], valor: 3_000_000n });
  });

  it("preserva el orden de PRIMERA aparición de cada trámite, no el orden alfabético", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "zzz-ultimo", valor: 100n },
      { facturaProveedorId: "f2", tramiteId: "aaa-primero", valor: 200n },
    ];

    const grupos = agruparFacturasPorTramite(items);

    expect(grupos.map((g) => g.tramiteId)).toEqual(["zzz-ultimo", "aaa-primero"]);
  });

  it("conserva el total exacto: Σ grupo.valor == Σ item.valor (tolerancia 0)", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "t1", valor: 12_345_678n },
      { facturaProveedorId: "f2", tramiteId: "t2", valor: 999n },
      { facturaProveedorId: "f3", tramiteId: "t1", valor: 1n },
      { facturaProveedorId: "f4", tramiteId: "t3", valor: 7_000_001n },
      { facturaProveedorId: "f5", tramiteId: "t2", valor: 250_000n },
    ];

    const totalEsperado = items.reduce((sum, i) => sum + i.valor, 0n);
    const grupos = agruparFacturasPorTramite(items);
    const totalGrupos = grupos.reduce((sum, g) => sum + g.valor, 0n);

    expect(totalGrupos).toBe(totalEsperado);
  });

  it("no pierde ni duplica facturas: el total de facturaIds across grupos == items.length", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "t1", valor: 1n },
      { facturaProveedorId: "f2", tramiteId: "t2", valor: 1n },
      { facturaProveedorId: "f3", tramiteId: "t1", valor: 1n },
      { facturaProveedorId: "f4", tramiteId: "t2", valor: 1n },
    ];

    const grupos = agruparFacturasPorTramite(items);
    const totalFacturas = grupos.reduce((sum, g) => sum + g.facturaIds.length, 0);

    expect(totalFacturas).toBe(items.length);
  });

  it("lista vacía → sin grupos", () => {
    expect(agruparFacturasPorTramite([])).toEqual([]);
  });

  it("una sola factura de un solo trámite → un solo grupo (degenera al pago suelto)", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "t1", valor: 500_000n },
    ];
    const grupos = agruparFacturasPorTramite(items);
    expect(grupos).toEqual([{ tramiteId: "t1", facturaIds: ["f1"], valor: 500_000n }]);
  });
});

describe("repartirCostoBancario", () => {
  it("un solo trámite → se lleva el costo completo", () => {
    const reparto = repartirCostoBancario(["t1"], 3_900n);
    expect(reparto.get("t1")).toBe(3_900n);
  });

  it("varios trámites → el costo se imputa COMPLETO al primero, los demás en 0 (no se cobra N veces)", () => {
    const reparto = repartirCostoBancario(["t1", "t2", "t3"], 7_300n);
    expect(reparto.get("t1")).toBe(7_300n);
    expect(reparto.get("t2")).toBe(0n);
    expect(reparto.get("t3")).toBe(0n);
  });

  it("el orden del reparto sigue el orden de aparición recibido, no un orden alfabético", () => {
    const reparto = repartirCostoBancario(["zzz-segundo-en-la-lista", "aaa-primero-en-la-lista"], 1_950n);
    // El primero en la LISTA (no alfabético) se lleva el costo.
    expect(reparto.get("zzz-segundo-en-la-lista")).toBe(1_950n);
    expect(reparto.get("aaa-primero-en-la-lista")).toBe(0n);
  });

  it("Σ reparto == costoBancarioTotal exacto, sin importar cuántos trámites agrupe (tolerancia 0)", () => {
    const tramiteIds = ["t1", "t2", "t3", "t4", "t5"];
    const costoTotal = 11_290n; // BANCOLOMBIA_SUCURSAL
    const reparto = repartirCostoBancario(tramiteIds, costoTotal);
    const suma = tramiteIds.reduce((sum, id) => sum + (reparto.get(id) ?? 0n), 0n);
    expect(suma).toBe(costoTotal);
  });

  it("costo bancario 0 (ej. PSE) → todos los grupos quedan en 0, suma exacta", () => {
    const reparto = repartirCostoBancario(["t1", "t2"], 0n);
    expect(reparto.get("t1")).toBe(0n);
    expect(reparto.get("t2")).toBe(0n);
  });

  it("lista vacía de trámites → mapa vacío", () => {
    const reparto = repartirCostoBancario([], 5_000n);
    expect(reparto.size).toBe(0);
  });
});

describe("integración agrupar + repartir (flujo completo del lote)", () => {
  it("caso de Karina: 2 trámites, costo bancario único no se duplica y el total del lote cuadra exacto", () => {
    const items: FacturaLoteItem[] = [
      { facturaProveedorId: "f1", tramiteId: "DO-1", valor: 4_500_000n },
      { facturaProveedorId: "f2", tramiteId: "DO-2", valor: 2_300_000n },
      { facturaProveedorId: "f3", tramiteId: "DO-1", valor: 800_000n },
    ];
    const costoBancarioTotal = 3_900n; // TRANSF_BANCOLOMBIA, un solo desembolso

    const grupos = agruparFacturasPorTramite(items);
    const reparto = repartirCostoBancario(grupos.map((g) => g.tramiteId), costoBancarioTotal);

    // Σ PagoTramite.valor del lote == Σ montos pagados de las facturas seleccionadas.
    const totalPagoTramite = grupos.reduce((sum, g) => sum + g.valor, 0n);
    const totalFacturas = items.reduce((sum, i) => sum + i.valor, 0n);
    expect(totalPagoTramite).toBe(totalFacturas);
    expect(totalPagoTramite).toBe(7_600_000n);

    // Σ costoBancario del lote == costo real cobrado UNA vez por el banco.
    const totalCostoBancario = grupos.reduce((sum, g) => sum + (reparto.get(g.tramiteId) ?? 0n), 0n);
    expect(totalCostoBancario).toBe(costoBancarioTotal);

    // DO-1 fue el primero en aparecer → se lleva el costo bancario completo.
    expect(reparto.get("DO-1")).toBe(3_900n);
    expect(reparto.get("DO-2")).toBe(0n);
  });
});
