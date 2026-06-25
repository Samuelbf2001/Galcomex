/**
 * Tests para resolverNit4x1000 — POLÍTICA ACTUALIZADA (C3):
 * Siempre retorna el NIT del Banco de Occidente S.A. (890300279),
 * independientemente del canal de pago del trámite.
 *
 * La lógica condicional previa (Bancolombia vs otro banco) fue eliminada
 * porque el GMF se retiene a través del banco donde Galcomex concentra sus
 * operaciones con el socio LM, que es Banco de Occidente.
 */

import { describe, expect, it } from "vitest";

import { resolverNit4x1000, NIT_BANCO_OCCIDENTE } from "@/lib/siigo/envio-factura-service";

const banco = (nombre: string, nit: string | null) => ({
  nit,
  nombre,
});

describe("resolverNit4x1000 — siempre Banco de Occidente (890300279)", () => {
  it("NIT_BANCO_OCCIDENTE exporta el valor correcto", () => {
    expect(NIT_BANCO_OCCIDENTE).toBe("890300279");
  });

  it("retorna Banco de Occidente aunque todos los pagos sean Bancolombia", () => {
    const pagos = [
      {
        canalPago: "TRANSF_BANCOLOMBIA",
        valor: 1_000_000n,
        bancoBeneficiario: banco("Bancolombia", "890903938"),
      },
      {
        canalPago: "TRANSF_BANCOLOMBIA",
        valor: 500_000n,
        bancoBeneficiario: banco("Bancolombia", "890903938"),
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe(NIT_BANCO_OCCIDENTE);
  });

  it("retorna Banco de Occidente con canal mixto (Bancolombia + otros)", () => {
    const pagos = [
      {
        canalPago: "TRANSF_BANCOLOMBIA",
        valor: 1_000_000n,
        bancoBeneficiario: banco("Bancolombia", "890903938"),
      },
      {
        canalPago: "TRANSF_OTROS_BANCOS",
        valor: 800_000n,
        bancoBeneficiario: banco("Davivienda", "860034313"),
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe(NIT_BANCO_OCCIDENTE);
  });

  it("retorna Banco de Occidente con solo pagos PSE", () => {
    const pagos = [
      {
        canalPago: "PSE",
        valor: 5_000_000n,
        bancoBeneficiario: null,
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe(NIT_BANCO_OCCIDENTE);
  });

  it("retorna Banco de Occidente sin pagos (lista vacía)", () => {
    expect(resolverNit4x1000([], "800197268")).toBe(NIT_BANCO_OCCIDENTE);
  });

  it("retorna Banco de Occidente aunque el fallback sea null", () => {
    expect(resolverNit4x1000([], null)).toBe(NIT_BANCO_OCCIDENTE);
  });

  it("retorna Banco de Occidente con pagos TRANSF_OTROS_BANCOS sin banco asignado", () => {
    const pagos = [
      {
        canalPago: "TRANSF_OTROS_BANCOS",
        valor: 500_000n,
        bancoBeneficiario: null,
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe(NIT_BANCO_OCCIDENTE);
  });
});
