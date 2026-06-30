/**
 * Caso dorado del cruce interno Galcomex ↔ Luis Martínez.
 * Fuente de verdad: Excel BAQ-18453 (DO.CTG26-0118), hoja GRUPO E PAPIS 2026.
 * Tolerancia: 0 pesos.
 */

import { describe, expect, it } from "vitest";

import { calcularSaldoLMInterno } from "../cruce-lm";

// ── Datos BAQ-18453 (SOCIO_LM) ────────────────────────────────────────────────
const ANTICIPO = 35_074_500n;
const TOTAL_PAGOS = 32_931_686n;
const COMISION_INTERNA_LM = 150_000n; // la mínima de Lucho (NO la 400.000 de factura)
const IVA_COMISION = 76_000n; // manual, como la hoja
const COSTOS_BANCARIOS = 9_750n; // recaudo anticipo 1.950 + Σ costos pagos 7.800
const TASA_4X1000 = 400n; // 0.004 escalado /100_000

// Saldo a favor del cliente (lado factura, line-driven — no lo calcula este helper).
const SALDO_A_FAVOR_CLIENTE = 1_946_500n;

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
    expect(r.impuesto4x1000Interno).toBe(140_298n);
  });

  it("saldoLMInterno = 1.766.766", () => {
    expect(r.saldoLMInterno).toBe(1_766_766n);
  });

  it("cruce final saldoLM = saldoLMInterno − saldoAFavorCliente = −179.734", () => {
    const saldoLM = r.saldoLMInterno - SALDO_A_FAVOR_CLIENTE;
    expect(saldoLM).toBe(-179_734n);
  });

  it("comisión interna distinta de la de factura no cancela el cruce", () => {
    // Con la comisión de factura (400.000) el cruce daría −429.734; con la
    // interna (150.000) da −179.734. La diferencia (250.000) es el margen de Lucho.
    const conComisionFactura = calcularSaldoLMInterno({
      totalAnticipo: ANTICIPO,
      totalPagos: TOTAL_PAGOS,
      comisionInternaLM: 400_000n,
      ivaComision: IVA_COMISION,
      costosBancarios: COSTOS_BANCARIOS,
      tasa4x1000: TASA_4X1000,
    });
    expect(conComisionFactura.saldoLMInterno - SALDO_A_FAVOR_CLIENTE).toBe(
      -429_734n,
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
