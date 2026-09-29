/**
 * Caso dorado del cruce interno Galcomex ↔ Luis Martínez.
 * Fuente de verdad: Excel BAQ-18453 (DO.CTG26-0118), hoja GRUPO E PAPIS 2026.
 * Tolerancia: 0 pesos.
 */

import { describe, expect, it } from "vitest";
import { pesos } from "@/lib/dinero";

import { calcularSaldoLMInterno } from "../cruce-lm";

// ── Datos BAQ-18453 (SOCIO_LM) ────────────────────────────────────────────────
const ANTICIPO = pesos(35_074_500);
const TOTAL_PAGOS = pesos(32_931_686);
const COMISION_INTERNA_LM = pesos(150_000); // la mínima de Lucho (NO la 400.000 de factura)
const IVA_COMISION = pesos(76_000); // manual, como la hoja
const COSTOS_BANCARIOS = pesos(9_750); // recaudo anticipo 1.950 + Σ costos pagos 7.800
const TASA_4X1000 = 400n; // 0.004 escalado /100_000

// Saldo a favor del cliente (lado factura, line-driven — no lo calcula este helper).
const SALDO_A_FAVOR_CLIENTE = pesos(1_946_500);

describe("calcularSaldoLMInterno — BAQ-18453", () => {
  const r = calcularSaldoLMInterno({
    totalAnticipo: ANTICIPO,
    totalPagos: TOTAL_PAGOS,
    comisionInternaLM: COMISION_INTERNA_LM,
    ivaComision: IVA_COMISION,
    costosBancarios: COSTOS_BANCARIOS,
    tasa4x1000: TASA_4X1000,
  });

  it("4x1000 interno = base anticipo = 140.298", () => {
    expect(r.impuesto4x1000Interno).toBe(pesos(140_298));
  });

  it("saldoLMInterno = 1.766.766", () => {
    expect(r.saldoLMInterno).toBe(pesos(1_766_766));
  });

  it("cruce final saldoLM = saldoLMInterno − saldoAFavorCliente = −179.734", () => {
    const saldoLM = r.saldoLMInterno - SALDO_A_FAVOR_CLIENTE;
    expect(saldoLM).toBe(-pesos(179_734));
  });

  it("comisión interna distinta de la de factura no cancela el cruce", () => {
    // Con la comisión de factura (400.000) el cruce daría −429.734; con la
    // interna (150.000) da −179.734. La diferencia (250.000) es el margen de Lucho.
    const conComisionFactura = calcularSaldoLMInterno({
      totalAnticipo: ANTICIPO,
      totalPagos: TOTAL_PAGOS,
      comisionInternaLM: pesos(400_000),
      ivaComision: IVA_COMISION,
      costosBancarios: COSTOS_BANCARIOS,
      tasa4x1000: TASA_4X1000,
    });
    expect(conComisionFactura.saldoLMInterno - SALDO_A_FAVOR_CLIENTE).toBe(
      -pesos(429_734),
    );
  });

  it("sin anticipo no hay 4x1000 interno", () => {
    const sinAnticipo = calcularSaldoLMInterno({
      totalAnticipo: 0n,
      totalPagos: 0n,
      comisionInternaLM: 0n,
      ivaComision: 0n,
      costosBancarios: 0n,
      tasa4x1000: TASA_4X1000,
    });
    expect(sinAnticipo.impuesto4x1000Interno).toBe(0n);
    expect(sinAnticipo.saldoLMInterno).toBe(0n);
  });
});

describe("calcularSaldoLMInterno — 4x1000 interno truncado al peso en centavos (D-2)", () => {
  it("anticipo con centavos: 1.249,99 × 0,4 % = 4,99996 → 4 (truncado)", () => {
    const r = calcularSaldoLMInterno({
      totalAnticipo: 124_999n,
      totalPagos: 0n,
      comisionInternaLM: 0n,
      ivaComision: 0n,
      costosBancarios: 0n,
      tasa4x1000: 400n,
    });
    expect(r.impuesto4x1000Interno).toBe(pesos(4));
    expect(r.saldoLMInterno).toBe(124_999n - pesos(4));
  });
});
