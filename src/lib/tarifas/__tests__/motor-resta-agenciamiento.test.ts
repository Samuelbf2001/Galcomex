import { describe, expect, it } from "vitest";

import {
  calcularLineasTarifa,
  type ContextoTarifa,
  type ItemTarifaCalculable,
} from "../motor";
import { restarAgenciamiento } from "../resta-agenciamiento";

/**
 * B1 (Diseño A, 27-sep-2026) — casos dorados de "restar el agenciamiento de
 * la agencia de aduanas del DO" (§6.1 de `simulacion-camila-27sep/DISENO-A.md`).
 * Todos los números se verificaron con un cálculo independiente; tolerancia 0.
 * M16 (sin la casilla, motor idéntico a hoy) lo cubre `motor.test.ts`, sin tocar.
 */

const $ = (n: number) => BigInt(n);

function item(
  parcial: Partial<ItemTarifaCalculable> & Pick<ItemTarifaCalculable, "concepto" | "tipoCalculo">,
): ItemTarifaCalculable {
  return {
    nombrePublico: parcial.concepto,
    siigoCodigo: null,
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    orden: 0,
    ...parcial,
  };
}

function ctx(parcial: Partial<ContextoTarifa> = {}): ContextoTarifa {
  return {
    valorCif: null,
    tipoCarga: null,
    numContenedores: null,
    numDeclaraciones: null,
    numDocumentos: null,
    numItems: null,
    eventos: [],
    costos: [],
    ...parcial,
  };
}

const COLDEX = { agencia: "COLDEX", valor: $(145_000) };

function unicaLinea(items: ItemTarifaCalculable[], contexto: ContextoTarifa) {
  const resultado = calcularLineasTarifa(items, contexto);
  expect(resultado.pendientes).toEqual([]);
  expect(resultado.lineas).toHaveLength(1);
  return resultado.lineas[0]!;
}

describe("motor + resta-agenciamiento (B1) — casos dorados", () => {
  it("M1 — Sesderma CTG DO.CTG26-0148 (20 bps, mín. 305.000 NETO, resta)", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ valorCif: $(678_819_984), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    const linea = unicaLinea(items, c);
    expect(linea.valor).toBe($(1_212_640));
    expect(linea.detalle).toBe(
      "0,20 % sobre CIF 678.819.984 = 1.357.640; menos agenciamiento COLDEX 145.000",
    );
  });

  it("M1b — igual, modo TOTAL (mín. 450.000)", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "450000" },
        restaAgenciamiento: true,
        minimoEsDelTotal: true,
      }),
    ];
    const c = ctx({ valorCif: $(678_819_984), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(1_212_640));
  });

  it("M2 — Sesderma BGT DO.BGT26-0157 (30 bps, mín. 305.000, resta)", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 30,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ valorCif: $(366_656_725), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(954_970));
  });

  it("M3 — Sesderma CTG en el mínimo DO.CTG26-0043 (NETO)", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ valorCif: $(220_664_129), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    const linea = unicaLinea(items, c);
    expect(linea.valor).toBe($(305_000));
    expect(linea.detalle).toBe(
      "0,20 % sobre CIF 220.664.129 = 441.328; menos agenciamiento COLDEX 145.000 = 296.328; aplica mínimo carga suelta 305.000",
    );
  });

  it("M3b — igual, TOTAL 450.000", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "450000" },
        restaAgenciamiento: true,
        minimoEsDelTotal: true,
      }),
    ];
    const c = ctx({ valorCif: $(220_664_129), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    const linea = unicaLinea(items, c);
    expect(linea.valor).toBe($(305_000));
    expect(linea.detalle).toBe(
      "0,20 % sobre CIF 220.664.129 = 441.328; aplica mínimo total carga suelta 450.000; menos agenciamiento COLDEX 145.000",
    );
  });

  it("M4 — Sesderma BGT en el mínimo DO.BGT26-0216 (30 bps < 0, cae al mínimo)", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 30,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ valorCif: $(38_278_014), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    const linea = unicaLinea(items, c);
    expect(linea.valor).toBe($(305_000));
    // BAJO 1 (revisión de código, 28-sep-2026): el % (114.834) no alcanza a
    // cubrir la agencia (145.000) — el paso intermedio negativo se omite,
    // nunca "= -30.166".
    expect(linea.detalle).toBe(
      "0,30 % sobre CIF 38.278.014 = 114.834; menos agenciamiento COLDEX 145.000; aplica mínimo carga suelta 305.000",
    );
  });

  it("M5 — Polyrec ZF nacionalización DO.26-0171 (30 bps, mín. 255.000)", () => {
    const items = [
      item({
        concepto: "NACIONALIZACION",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 30,
        minimos: { SUELTA: "255000" },
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ valorCif: $(51_066_071), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(255_000));
  });

  it("M6 — Z7c (CIF de prueba 150.000.000)", () => {
    const items = [
      item({
        concepto: "NACIONALIZACION",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 30,
        minimos: { SUELTA: "255000" },
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ valorCif: $(150_000_000), tipoCarga: "SUELTA", agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(305_000));
  });

  it("M7 — Triplex DO.CTG26-0095 (POR_UNIDAD CONTENEDOR 600.000, resta, 4 contenedores)", () => {
    const items = [
      item({
        concepto: "SERVICIO",
        tipoCalculo: "POR_UNIDAD",
        unidad: "CONTENEDOR",
        valor: $(600_000),
        restaAgenciamiento: true,
      }),
    ];
    const c = ctx({ numContenedores: 4, agenciamiento: COLDEX });
    const linea = unicaLinea(items, c);
    expect(linea.valor).toBe($(2_255_000));
    expect(linea.detalle).toBe("600.000 × 4 contenedores = 2.400.000; menos agenciamiento COLDEX 145.000");
  });

  it("M7b — Triplex, 1 · 2 · 5 contenedores", () => {
    const items = [
      item({
        concepto: "SERVICIO",
        tipoCalculo: "POR_UNIDAD",
        unidad: "CONTENEDOR",
        valor: $(600_000),
        restaAgenciamiento: true,
      }),
    ];
    expect(unicaLinea(items, ctx({ numContenedores: 1, agenciamiento: COLDEX })).valor).toBe($(455_000));
    expect(unicaLinea(items, ctx({ numContenedores: 2, agenciamiento: COLDEX })).valor).toBe($(1_055_000));
    expect(unicaLinea(items, ctx({ numContenedores: 5, agenciamiento: COLDEX })).valor).toBe($(2_855_000));
  });

  it("M7c — Triplex carga suelta (0 contenedores) → pendiente NO_ALCANZA, nunca línea negativa", () => {
    const items = [
      item({
        concepto: "SERVICIO",
        tipoCalculo: "POR_UNIDAD",
        unidad: "CONTENEDOR",
        valor: $(600_000),
        restaAgenciamiento: true,
      }),
    ];
    const resultado = calcularLineasTarifa(items, ctx({ numContenedores: 0, agenciamiento: COLDEX }));
    expect(resultado.lineas).toEqual([]);
    expect(resultado.pendientes).toHaveLength(1);
    expect(resultado.pendientes[0]!.causa).toBe("TARIFARIO");
    expect(resultado.pendientes[0]!.motivo).toBe(
      "El cobro de 0 (sin contenedores) no alcanza para restar el agenciamiento de COLDEX (145.000). Revisa la tarifa o escribe la comisión a mano.",
    );
  });

  it("M8 — Pierco (POR_UNIDAD 500.000, resta), 1 · 2", () => {
    const items = [
      item({
        concepto: "SERVICIO",
        tipoCalculo: "POR_UNIDAD",
        unidad: "CONTENEDOR",
        valor: $(500_000),
        restaAgenciamiento: true,
      }),
    ];
    expect(unicaLinea(items, ctx({ numContenedores: 1, agenciamiento: COLDEX })).valor).toBe($(355_000));
    expect(unicaLinea(items, ctx({ numContenedores: 2, agenciamiento: COLDEX })).valor).toBe($(855_000));
  });

  it("M9 — Orthofract 26-0169 (30 bps, resta, sin mínimo)", () => {
    const items = [
      item({ concepto: "ASESORIA", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 30, restaAgenciamiento: true }),
    ];
    const c = ctx({ valorCif: $(2_259_002_330), agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(6_632_007));
  });

  it("M10 — El Tapicero 26-0242 (45 bps, resta)", () => {
    const items = [
      item({ concepto: "ASESORIA", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 45, restaAgenciamiento: true }),
    ];
    const c = ctx({ valorCif: $(281_982_480), agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(1_123_921));
  });

  it("M11 — Regresión BGT26-0183 (30 bps, resta) — hoy daba 1.325.559 de más", () => {
    const items = [
      item({ concepto: "ASESORIA", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 30, restaAgenciamiento: true }),
    ];
    const c = ctx({ valorCif: $(441_853_051), agenciamiento: COLDEX });
    expect(unicaLinea(items, c).valor).toBe($(1_180_559));
  });

  it("M12 — Coldex hipotético 160.000, Sesderma CTG en el mínimo: NETO 305.000 · TOTAL 290.000", () => {
    const agencia = { agencia: "COLDEX", valor: $(160_000) };
    const neto = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const total = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "450000" },
        restaAgenciamiento: true,
        minimoEsDelTotal: true,
      }),
    ];
    const c = ctx({ valorCif: $(220_664_129), tipoCarga: "SUELTA", agenciamiento: agencia });
    expect(unicaLinea(neto, c).valor).toBe($(305_000));
    expect(unicaLinea(total, c).valor).toBe($(290_000));
  });

  it("M12b — igual, CIF 678.819.984: NETO y TOTAL dan 1.197.640", () => {
    const agencia = { agencia: "COLDEX", valor: $(160_000) };
    const neto = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const total = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "450000" },
        restaAgenciamiento: true,
        minimoEsDelTotal: true,
      }),
    ];
    const c = ctx({ valorCif: $(678_819_984), tipoCarga: "SUELTA", agenciamiento: agencia });
    expect(unicaLinea(neto, c).valor).toBe($(1_197_640));
    expect(unicaLinea(total, c).valor).toBe($(1_197_640));
  });

  it("M12c — igual, ZF (mín. 255.000 / total 400.000): NETO 255.000 · TOTAL 240.000", () => {
    const agencia = { agencia: "COLDEX", valor: $(160_000) };
    const neto = [
      item({
        concepto: "NACIONALIZACION",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 30,
        minimos: { SUELTA: "255000" },
        restaAgenciamiento: true,
      }),
    ];
    const total = [
      item({
        concepto: "NACIONALIZACION",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 30,
        minimos: { SUELTA: "400000" },
        restaAgenciamiento: true,
        minimoEsDelTotal: true,
      }),
    ];
    const c = ctx({ valorCif: $(51_066_071), tipoCarga: "SUELTA", agenciamiento: agencia });
    expect(unicaLinea(neto, c).valor).toBe($(255_000));
    expect(unicaLinea(total, c).valor).toBe($(240_000));
  });

  it("M13 — DO sin agencia → pendiente causa BASE_DO", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const resultado = calcularLineasTarifa(
      items,
      ctx({ valorCif: $(220_664_129), tipoCarga: "SUELTA", agenciamiento: { agencia: null, valor: null } }),
    );
    expect(resultado.lineas).toEqual([]);
    expect(resultado.pendientes).toHaveLength(1);
    expect(resultado.pendientes[0]!.causa).toBe("BASE_DO");
    expect(resultado.pendientes[0]!.motivo).toBe(
      "El DO no tiene agencia de aduanas: no se puede restar su agenciamiento. Complétala en el DO.",
    );
  });

  it("M13b — sin `ctx.agenciamiento` en absoluto se comporta igual que sin agencia", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const resultado = calcularLineasTarifa(items, ctx({ valorCif: $(220_664_129), tipoCarga: "SUELTA" }));
    expect(resultado.lineas).toEqual([]);
    expect(resultado.pendientes[0]!.causa).toBe("BASE_DO");
  });

  it("M14 — agencia sin valor estándar → pendiente causa TARIFARIO", () => {
    const items = [
      item({
        concepto: "ASESORIA",
        tipoCalculo: "PORCENTAJE_MIN",
        porcentajeBps: 20,
        minimos: { SUELTA: "305000" },
        restaAgenciamiento: true,
      }),
    ];
    const resultado = calcularLineasTarifa(
      items,
      ctx({ valorCif: $(220_664_129), tipoCarga: "SUELTA", agenciamiento: { agencia: "COLDEX", valor: null } }),
    );
    expect(resultado.lineas).toEqual([]);
    expect(resultado.pendientes).toHaveLength(1);
    expect(resultado.pendientes[0]!.causa).toBe("TARIFARIO");
    expect(resultado.pendientes[0]!.motivo).toBe(
      "Falta el agenciamiento estándar de COLDEX: Configuración → Parámetros → AGENCIAMIENTO_COLDEX.",
    );
  });

  it("M15 — agenciamiento en 0 es válido y equivale a no restar nada", () => {
    const itemConResta = item({
      concepto: "ASESORIA",
      tipoCalculo: "PORCENTAJE_MIN",
      porcentajeBps: 20,
      minimos: { SUELTA: "305000" },
      restaAgenciamiento: true,
    });
    const itemSinResta = item({
      concepto: "ASESORIA",
      tipoCalculo: "PORCENTAJE_MIN",
      porcentajeBps: 20,
      minimos: { SUELTA: "305000" },
    });
    const cConResta = ctx({
      valorCif: $(678_819_984),
      tipoCarga: "SUELTA",
      agenciamiento: { agencia: "COLDEX", valor: 0n },
    });
    const cSinResta = ctx({ valorCif: $(678_819_984), tipoCarga: "SUELTA" });
    expect(unicaLinea([itemConResta], cConResta).valor).toBe(unicaLinea([itemSinResta], cSinResta).valor);
  });
});

describe("restarAgenciamiento (función pura)", () => {
  it("SIN_AGENCIA cuando agencia es null", () => {
    const r = restarAgenciamiento({
      valorCalculado: 100n,
      minimoEsDelTotal: false,
      agencia: null,
      agenciamiento: 145_000n,
    });
    expect(r).toEqual({ ok: false, motivo: "SIN_AGENCIA", bruto: 100n });
  });

  it("AGENCIA_SIN_VALOR cuando agenciamiento es null", () => {
    const r = restarAgenciamiento({
      valorCalculado: 100n,
      minimoEsDelTotal: false,
      agencia: "COLDEX",
      agenciamiento: null,
    });
    expect(r).toEqual({ ok: false, motivo: "AGENCIA_SIN_VALOR", bruto: 100n });
  });

  it("NO_ALCANZA cuando el neto queda en 0 o negativo (nunca línea negativa)", () => {
    const r = restarAgenciamiento({
      valorCalculado: 100_000n,
      minimoEsDelTotal: false,
      agencia: "COLDEX",
      agenciamiento: 145_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("NO_ALCANZA");
  });

  it("neto exactamente 0 también es NO_ALCANZA (nunca un cero silencioso)", () => {
    const r = restarAgenciamiento({
      valorCalculado: 145_000n,
      minimoEsDelTotal: false,
      agencia: "COLDEX",
      agenciamiento: 145_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("NO_ALCANZA");
  });
});
