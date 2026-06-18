/**
 * Tests de la función pura calcularDiasYAlerta — A2-T8
 *
 * Verifica el comportamiento del SLA de facturación:
 * un DO con más de 3 días desde despacho sin factura debe activar la alerta.
 */

import { describe, expect, it } from "vitest";

import { calcularDiasYAlerta } from "../service";

// ─── Función auxiliar ─────────────────────────────────────────────────────────

/** Crea una fecha N días antes de `hoy`. */
function diasAtras(n: number, hoy: Date): Date {
  const d = new Date(hoy);
  d.setDate(d.getDate() - n);
  return d;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("calcularDiasYAlerta", () => {
  const HOY = new Date("2026-06-12T12:00:00.000Z");

  it("fechaRef null → 0 días, sin alerta", () => {
    const result = calcularDiasYAlerta(null, HOY);
    expect(result.dias).toBe(0);
    expect(result.alerta).toBe(false);
  });

  it("0 días (despacho hoy) → 0 días, sin alerta", () => {
    const fechaHoy = new Date(HOY);
    const result = calcularDiasYAlerta(fechaHoy, HOY);
    expect(result.dias).toBe(0);
    expect(result.alerta).toBe(false);
  });

  it("2 días → sin alerta (dentro del SLA de 3 días)", () => {
    const fecha = diasAtras(2, HOY);
    const result = calcularDiasYAlerta(fecha, HOY);
    expect(result.dias).toBe(2);
    expect(result.alerta).toBe(false);
  });

  it("3 días → sin alerta (exactamente en el SLA, no excede)", () => {
    const fecha = diasAtras(3, HOY);
    const result = calcularDiasYAlerta(fecha, HOY);
    expect(result.dias).toBe(3);
    expect(result.alerta).toBe(false);
  });

  it("4 días → alerta true (excede el SLA de 3 días)", () => {
    const fecha = diasAtras(4, HOY);
    const result = calcularDiasYAlerta(fecha, HOY);
    expect(result.dias).toBe(4);
    expect(result.alerta).toBe(true);
  });

  it("10 días → alerta true con conteo correcto", () => {
    const fecha = diasAtras(10, HOY);
    const result = calcularDiasYAlerta(fecha, HOY);
    expect(result.dias).toBe(10);
    expect(result.alerta).toBe(true);
  });

  it("SLA personalizado: slaDias=5 → 5 días sin alerta", () => {
    const fecha = diasAtras(5, HOY);
    const result = calcularDiasYAlerta(fecha, HOY, 5);
    expect(result.dias).toBe(5);
    expect(result.alerta).toBe(false);
  });

  it("SLA personalizado: slaDias=5 → 6 días con alerta", () => {
    const fecha = diasAtras(6, HOY);
    const result = calcularDiasYAlerta(fecha, HOY, 5);
    expect(result.dias).toBe(6);
    expect(result.alerta).toBe(true);
  });

  it("fecha futura → 0 días (no resultado negativo)", () => {
    const fechaFutura = new Date(HOY);
    fechaFutura.setDate(fechaFutura.getDate() + 2);
    const result = calcularDiasYAlerta(fechaFutura, HOY);
    expect(result.dias).toBe(0);
    expect(result.alerta).toBe(false);
  });
});
