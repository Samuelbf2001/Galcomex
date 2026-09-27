/**
 * Transiciones de estado del DO — lógica pura, sin BD.
 *
 * El mapa estándar es igual para todos los tipos; el flujo corto (OTRO,
 * decisión de Ernesto 26-sep-2026) agrega el atajo directo a
 * ENVIADO_A_FACTURAR desde SOLICITUD/APERTURA/EN_TRAMITE.
 */

import { describe, expect, it } from "vitest";

import { estadosSiguientes } from "../transiciones";

describe("estadosSiguientes — mapa estándar (flujoCorto: false)", () => {
  it("es exactamente el camino lineal de siempre, sin atajos", () => {
    expect(estadosSiguientes("SOLICITUD", { flujoCorto: false })).toEqual(["APERTURA"]);
    expect(estadosSiguientes("APERTURA", { flujoCorto: false })).toEqual(["EN_TRAMITE"]);
    expect(estadosSiguientes("EN_TRAMITE", { flujoCorto: false })).toEqual(["EN_PUERTO"]);
    expect(estadosSiguientes("EN_PUERTO", { flujoCorto: false })).toEqual(["DESPACHADO"]);
    expect(estadosSiguientes("DESPACHADO", { flujoCorto: false })).toEqual(["ENVIADO_A_FACTURAR"]);
    expect(estadosSiguientes("ENVIADO_A_FACTURAR", { flujoCorto: false })).toEqual(["FACTURADO"]);
    expect(estadosSiguientes("FACTURADO", { flujoCorto: false })).toEqual(["PAGADO"]);
    expect(estadosSiguientes("PAGADO", { flujoCorto: false })).toEqual(["CERRADO"]);
    expect(estadosSiguientes("CERRADO", { flujoCorto: false })).toEqual([]);
  });
});

describe("estadosSiguientes — flujo corto (OTRO)", () => {
  it("agrega el atajo a ENVIADO_A_FACTURAR desde SOLICITUD, APERTURA y EN_TRAMITE", () => {
    expect(estadosSiguientes("SOLICITUD", { flujoCorto: true })).toEqual([
      "APERTURA",
      "ENVIADO_A_FACTURAR",
    ]);
    expect(estadosSiguientes("APERTURA", { flujoCorto: true })).toEqual([
      "EN_TRAMITE",
      "ENVIADO_A_FACTURAR",
    ]);
    expect(estadosSiguientes("EN_TRAMITE", { flujoCorto: true })).toEqual([
      "EN_PUERTO",
      "ENVIADO_A_FACTURAR",
    ]);
  });

  it("no toca los estados donde el mapa estándar ya llega a ENVIADO_A_FACTURAR o más allá", () => {
    // DESPACHADO ya iba a ENVIADO_A_FACTURAR: no se duplica.
    expect(estadosSiguientes("DESPACHADO", { flujoCorto: true })).toEqual(["ENVIADO_A_FACTURAR"]);
    expect(estadosSiguientes("EN_PUERTO", { flujoCorto: true })).toEqual(["DESPACHADO"]);
    expect(estadosSiguientes("ENVIADO_A_FACTURAR", { flujoCorto: true })).toEqual(["FACTURADO"]);
    expect(estadosSiguientes("FACTURADO", { flujoCorto: true })).toEqual(["PAGADO"]);
    expect(estadosSiguientes("PAGADO", { flujoCorto: true })).toEqual(["CERRADO"]);
    expect(estadosSiguientes("CERRADO", { flujoCorto: true })).toEqual([]);
  });
});
