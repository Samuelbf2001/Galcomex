/**
 * Tests unitarios PUROS (sin BD) — desviación pago↔facturas (A1, reunión 1-jul-2026).
 * Tolerancia 0: los porcentajes se derivan de BigInt, nunca de flotantes.
 */
import { describe, expect, it } from "vitest";

import { calcularDesviacionPct, excedeUmbralDesviacion } from "../desviacion";

describe("calcularDesviacionPct", () => {
  it("valor igual a la suma de facturas → 0%", () => {
    expect(calcularDesviacionPct(100_000n, 100_000n)).toBe(0);
  });

  it("valor 10% por encima → +10", () => {
    expect(calcularDesviacionPct(110_000n, 100_000n)).toBe(10);
  });

  it("valor 10% por debajo → -10", () => {
    expect(calcularDesviacionPct(90_000n, 100_000n)).toBe(-10);
  });

  it("valor 50% por encima (caso de la reunión: factura 100.000, pago 150.000) → +50", () => {
    expect(calcularDesviacionPct(150_000n, 100_000n)).toBe(50);
  });

  it("sin base de comparación (sumaFacturas = 0) → 0", () => {
    expect(calcularDesviacionPct(50_000n, 0n)).toBe(0);
  });

  it("sumaFacturas negativa (no debería ocurrir, pero no debe explotar) → 0", () => {
    expect(calcularDesviacionPct(50_000n, -10_000n)).toBe(0);
  });

  it("trunca a una décima igual que el cálculo original del cliente", () => {
    // 33.333n / 100.000n = 33.333% exacto → trunca a 33.3
    expect(calcularDesviacionPct(133_333n, 100_000n)).toBe(33.3);
  });
});

describe("excedeUmbralDesviacion", () => {
  it("justo en el umbral (10%) NO excede — la regla es estrictamente mayor", () => {
    expect(excedeUmbralDesviacion(110_000n, 100_000n, 10)).toBe(false);
  });

  it("una décima más allá del umbral SÍ excede (10.1% > 10%)", () => {
    expect(excedeUmbralDesviacion(11_010n, 10_000n, 10)).toBe(true);
  });

  it("un punto porcentual entero más allá del umbral SÍ excede (11% > 10%)", () => {
    expect(excedeUmbralDesviacion(111_000n, 100_000n, 10)).toBe(true);
  });

  it("desviación negativa que excede el umbral en valor absoluto", () => {
    expect(excedeUmbralDesviacion(89_000n, 100_000n, 10)).toBe(true);
  });

  it("sin facturas (sumaFacturas = 0) nunca excede", () => {
    expect(excedeUmbralDesviacion(1_000_000n, 0n, 10)).toBe(false);
  });

  it("umbral configurado en 0 → cualquier desviación no nula (a la precisión de una décima) excede", () => {
    // precisión de una décima: 100 de 100.000 = 0.1%, el mínimo detectable
    expect(excedeUmbralDesviacion(100_100n, 100_000n, 0)).toBe(true);
    expect(excedeUmbralDesviacion(100_000n, 100_000n, 0)).toBe(false);
  });

  it("caso dorado-ish: BAQ-18453 Σ pagos 32.521.912 vs pago exacto no desvía", () => {
    expect(excedeUmbralDesviacion(32_521_912n, 32_521_912n, 10)).toBe(false);
  });
});
