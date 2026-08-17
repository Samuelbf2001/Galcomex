/**
 * Tests de la función pura evaluarAlertaCarteraCliente — C2
 *
 * Verifica la alerta de cartera acumulada por cliente (reunión 1-jul-2026,
 * 01:13:59–01:15:20): "Vamos a alertar cuando ya el cliente esté bajo menos
 * 20 millones." No requiere BD — es una función pura sobre BigInt, igual que
 * `calcularSaldoNeto` en `service.test.ts`.
 *
 * Convención de signo (idéntica a `calcularSaldoNeto`):
 *   saldoNetoAcumulado > 0 → Galcomex le debe a la parte (saldo a favor)
 *   saldoNetoAcumulado < 0 → la parte le debe a Galcomex (pendiente de cobro)
 */
import { describe, expect, it } from "vitest";

import { evaluarAlertaCarteraCliente } from "../service";

describe("evaluarAlertaCarteraCliente", () => {
  const UMBRAL = 20_000_000n;

  it("cliente con saldo a favor (Galcomex le debe) → nunca alerta, sin importar el monto", () => {
    // 50 millones a favor del cliente: la alerta es de cartera POR COBRAR, no de magnitud.
    const result = evaluarAlertaCarteraCliente(50_000_000n, UMBRAL);
    expect(result.deuda).toBe(0n);
    expect(result.alerta).toBe(false);
  });

  it("cliente saldado (0) → sin deuda, sin alerta", () => {
    const result = evaluarAlertaCarteraCliente(0n, UMBRAL);
    expect(result.deuda).toBe(0n);
    expect(result.alerta).toBe(false);
  });

  it("cliente debe menos del umbral → sin alerta", () => {
    // Cliente debe 15 millones (< 20 millones de umbral)
    const result = evaluarAlertaCarteraCliente(-15_000_000n, UMBRAL);
    expect(result.deuda).toBe(15_000_000n);
    expect(result.alerta).toBe(false);
  });

  it("cliente debe exactamente el umbral → sin alerta (umbral estricto, no incluyente)", () => {
    const result = evaluarAlertaCarteraCliente(-20_000_000n, UMBRAL);
    expect(result.deuda).toBe(20_000_000n);
    expect(result.alerta).toBe(false);
  });

  it("cliente debe 1 peso más que el umbral → alerta true", () => {
    const result = evaluarAlertaCarteraCliente(-20_000_001n, UMBRAL);
    expect(result.deuda).toBe(20_000_001n);
    expect(result.alerta).toBe(true);
  });

  it("caso de la reunión: cliente debe 22 millones (> 20 millones) → alerta true", () => {
    // 00:32:41: "tiene de 22 millones a Galcomex... ya no puedo darle más plata."
    const result = evaluarAlertaCarteraCliente(-22_000_000n, UMBRAL);
    expect(result.deuda).toBe(22_000_000n);
    expect(result.alerta).toBe(true);
  });

  it("umbral personalizado (0) → cualquier deuda positiva dispara alerta", () => {
    const result = evaluarAlertaCarteraCliente(-1n, 0n);
    expect(result.deuda).toBe(1n);
    expect(result.alerta).toBe(true);
  });

  it("tolerancia 0 pesos: monto grande exacto no pierde precisión (BigInt)", () => {
    const result = evaluarAlertaCarteraCliente(-35_074_500n, UMBRAL);
    expect(result.deuda).toBe(35_074_500n);
    expect(result.alerta).toBe(true);
  });
});
