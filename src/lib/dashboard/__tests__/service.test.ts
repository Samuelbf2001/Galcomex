/**
 * Tests de la función pura calcularDiasYAlerta — A2-T8
 *
 * Verifica el comportamiento del SLA de facturación:
 * un DO con más de 3 días desde despacho sin factura debe activar la alerta.
 */

import { describe, expect, it } from "vitest";

import { calcularDiasYAlerta, evaluarAlertaSaldoTramite } from "../service";

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

/**
 * Tests de la función pura evaluarAlertaSaldoTramite — C1
 *
 * Verifica la alerta de "saldo agotado" por trámite: cuando los pagos
 * superan los anticipos aplicados por más del umbral de política
 * (reunión 1-jul-2026, default UMBRAL_SALDO_TRAMITE_ALERTA = 200.000 COP).
 */
describe("evaluarAlertaSaldoTramite", () => {
  const UMBRAL = 200_000n;

  it("pagos menores a anticipos → deficit 0, sin alerta", () => {
    const result = evaluarAlertaSaldoTramite(10_000_000n, 8_000_000n, UMBRAL);
    expect(result.deficit).toBe(0n);
    expect(result.alerta).toBe(false);
  });

  it("pagos exactamente iguales a anticipos → deficit 0, sin alerta", () => {
    const result = evaluarAlertaSaldoTramite(5_000_000n, 5_000_000n, UMBRAL);
    expect(result.deficit).toBe(0n);
    expect(result.alerta).toBe(false);
  });

  it("pagos exceden anticipos pero dentro del umbral → sin alerta", () => {
    // Déficit de 150.000, umbral 200.000 → no excede
    const result = evaluarAlertaSaldoTramite(5_000_000n, 5_150_000n, UMBRAL);
    expect(result.deficit).toBe(150_000n);
    expect(result.alerta).toBe(false);
  });

  it("déficit exactamente igual al umbral → sin alerta (no excede, umbral estricto)", () => {
    const result = evaluarAlertaSaldoTramite(5_000_000n, 5_200_000n, UMBRAL);
    expect(result.deficit).toBe(200_000n);
    expect(result.alerta).toBe(false);
  });

  it("déficit supera el umbral por 1 peso → alerta true", () => {
    const result = evaluarAlertaSaldoTramite(5_000_000n, 5_200_001n, UMBRAL);
    expect(result.deficit).toBe(200_001n);
    expect(result.alerta).toBe(true);
  });

  it("trámite sin ningún anticipo pero con pagos → deficit = pagos, alerta true si excede umbral", () => {
    const result = evaluarAlertaSaldoTramite(0n, 500_000n, UMBRAL);
    expect(result.deficit).toBe(500_000n);
    expect(result.alerta).toBe(true);
  });

  it("trámite sin anticipos ni pagos → deficit 0, sin alerta", () => {
    const result = evaluarAlertaSaldoTramite(0n, 0n, UMBRAL);
    expect(result.deficit).toBe(0n);
    expect(result.alerta).toBe(false);
  });

  it("umbral personalizado (0) → cualquier déficit positivo dispara alerta", () => {
    const result = evaluarAlertaSaldoTramite(1_000_000n, 1_000_001n, 0n);
    expect(result.deficit).toBe(1n);
    expect(result.alerta).toBe(true);
  });

  it("tolerancia 0 pesos: montos grandes exactos no pierden precisión (BigInt)", () => {
    const anticipos = 45_226_000n;
    const pagos = 45_426_001n; // excede en 200.001, justo 1 peso sobre el umbral
    const result = evaluarAlertaSaldoTramite(anticipos, pagos, UMBRAL);
    expect(result.deficit).toBe(200_001n);
    expect(result.alerta).toBe(true);
  });
});
