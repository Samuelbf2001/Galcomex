import { describe, expect, it } from "vitest";

import { CAPACIDADES } from "@/lib/capacidades/catalogo";
import { resolverCapacidades, type OverrideCapacidad } from "@/lib/capacidades/resolver";
import {
  errorUnidades,
  totalesComision,
  unidadesDisponibles,
  valorUnitarioDe,
} from "@/lib/comisiones/calculo";

function empresaCon(overrides: OverrideCapacidad[] = []) {
  return resolverCapacidades(CAPACIDADES, [], overrides);
}

const LTRANS = (valor: unknown) =>
  empresaCon([{ codigo: "comision_por_evento", habilitado: true, config: { unidad: "CONTENEDOR", valor } }]);

describe("unidadesDisponibles", () => {
  it("son los contenedores del DO", () => {
    expect(unidadesDisponibles({ numContenedores: 4, tipoCarga: "CONTENEDOR_40" })).toBe(4);
  });

  it("la carga suelta cuenta como 1", () => {
    expect(unidadesDisponibles({ numContenedores: 0, tipoCarga: "SUELTA" })).toBe(1);
    expect(unidadesDisponibles({ numContenedores: null, tipoCarga: "SUELTA" })).toBe(1);
  });

  it("sin el número de contenedores no hay base (null, nunca 0)", () => {
    expect(unidadesDisponibles({ numContenedores: null, tipoCarga: null })).toBeNull();
    expect(unidadesDisponibles({ numContenedores: 0, tipoCarga: "CONTENEDOR_20" })).toBeNull();
  });
});

describe("valorUnitarioDe (config de comision_por_evento)", () => {
  it("lee el valor por contenedor", () => {
    expect(valorUnitarioDe(LTRANS("90000"))).toBe(90_000n);
    expect(valorUnitarioDe(LTRANS(" 90000 "))).toBe(90_000n);
  });

  it("vacío, con puntos o roto cuenta como 0 (sin configurar), nunca inventa", () => {
    expect(valorUnitarioDe(LTRANS("0"))).toBe(0n);
    expect(valorUnitarioDe(LTRANS(""))).toBe(0n);
    expect(valorUnitarioDe(LTRANS("90.000"))).toBe(0n);
    expect(valorUnitarioDe(LTRANS(90000))).toBe(0n);
    expect(valorUnitarioDe(empresaCon())).toBe(0n);
  });
});

describe("errorUnidades — de 4 contenedores, 2 de LTRANS", () => {
  const base = { disponibles: 4, otrasUnidades: 0, consecutivo: "DO.BAQ26-0280" };

  it("acepta hasta los contenedores del DO", () => {
    expect(errorUnidades({ ...base, unidades: 2 })).toBeNull();
    expect(errorUnidades({ ...base, unidades: 4 })).toBeNull();
  });

  it("no deja pasar de los contenedores del DO", () => {
    expect(errorUnidades({ ...base, unidades: 5 })).toBe(
      "El DO.BAQ26-0280 solo tiene 4 contenedores disponibles para comisión.",
    );
  });

  it("descuenta lo que ya lleva otra empresa en el mismo DO", () => {
    expect(errorUnidades({ ...base, otrasUnidades: 2, unidades: 2 })).toBeNull();
    expect(errorUnidades({ ...base, otrasUnidades: 3, unidades: 2 })).toBe(
      "El DO.BAQ26-0280 solo tiene 1 contenedor disponible para comisión (4 en total, 3 ya con comisión de otra empresa).",
    );
  });

  it("pide al menos 1 y el número de contenedores del DO", () => {
    expect(errorUnidades({ ...base, unidades: 0 })).toBe(
      "Escribe cuántos contenedores llevan comisión (1 o más).",
    );
    expect(errorUnidades({ ...base, disponibles: null, unidades: 1 })).toBe(
      "Primero escribe el número de contenedores del DO.BAQ26-0280 (o márcalo como carga suelta).",
    );
  });
});

describe("totalesComision — facturas reales de LTRANS (tolerancia 0)", () => {
  it("BAQ-18027 (oct-2025): 12 contenedores + 3 cargas sueltas = 15 × 90.000 + IVA = 1.606.500", () => {
    const filas = [
      ...[2, 1, 1, 1, 3, 2, 2].map((unidades) => ({ unidades, valorUnitario: 90_000n })),
      // Tres DOs de carga suelta: 1 unidad cada uno.
      ...[1, 1, 1].map((unidades) => ({ unidades, valorUnitario: 90_000n })),
    ];
    expect(totalesComision(filas, 19n)).toEqual({
      unidades: 15,
      subtotal: 1_350_000n,
      iva: 256_500n,
      total: 1_606_500n,
    });
  });

  it("BAQ-18028 (oct-2025): 17 contenedores × 90.000 + IVA = 1.820.700", () => {
    const filas = [2, 1, 3, 1, 1, 3, 3, 1, 2].map((unidades) => ({ unidades, valorUnitario: 90_000n }));
    expect(totalesComision(filas, 19n)).toEqual({
      unidades: 17,
      subtotal: 1_530_000n,
      iva: 290_700n,
      total: 1_820_700n,
    });
  });

  it("sin filas todo en cero", () => {
    expect(totalesComision([], 19n)).toEqual({ unidades: 0, subtotal: 0n, iva: 0n, total: 0n });
  });

  it("el IVA se redondea al peso (mitad hacia arriba)", () => {
    // 1 × 12.345 × 19 % = 2.345,55 → 2.346
    expect(totalesComision([{ unidades: 1, valorUnitario: 12_345n }], 19n).iva).toBe(2_346n);
  });
});
