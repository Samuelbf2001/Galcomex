/**
 * Tests para resolverNit4x1000 — decide qué NIT va como tercero de la línea
 * 4x1000 al enviar la factura a Siigo, según los canales de pago del trámite.
 */

import { describe, expect, it } from "vitest";

import { resolverNit4x1000 } from "@/lib/siigo/envio-factura-service";

const banco = (nombre: string, nit: string | null) => ({
  nit,
  nombre,
});

describe("resolverNit4x1000", () => {
  it("usa el NIT del banco Bancolombia cuando todos los pagos son Bancolombia", () => {
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

    expect(resolverNit4x1000(pagos, "800197268")).toBe("890903938");
  });

  it("toma el NIT del banco non-Bancolombia cuando hay canal mixto", () => {
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

    expect(resolverNit4x1000(pagos, "800197268")).toBe("860034313");
  });

  it("usa el banco del primer pago TRANSF_OTROS_BANCOS cuando ninguno es Bancolombia", () => {
    const pagos = [
      {
        canalPago: "TRANSF_OTROS_BANCOS",
        valor: 500_000n,
        bancoBeneficiario: banco("BBVA", "860003020"),
      },
      {
        canalPago: "PSE",
        valor: 200_000n,
        bancoBeneficiario: banco("Davivienda", "860034313"),
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe("860003020");
  });

  it("cae al NIT DIAN cuando no hay pagos", () => {
    expect(resolverNit4x1000([], "800197268")).toBe("800197268");
  });

  it("cae al fallback cuando todos Bancolombia pero ninguno tiene banco asignado (datos legacy)", () => {
    const pagos = [
      {
        canalPago: "TRANSF_BANCOLOMBIA",
        valor: 1_000_000n,
        bancoBeneficiario: null,
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe("800197268");
  });

  it("cae al fallback cuando el canal mixto pero los non-Bancolombia no tienen banco asignado", () => {
    const pagos = [
      {
        canalPago: "TRANSF_BANCOLOMBIA",
        valor: 1_000_000n,
        bancoBeneficiario: banco("Bancolombia", "890903938"),
      },
      {
        canalPago: "TRANSF_OTROS_BANCOS",
        valor: 500_000n,
        bancoBeneficiario: null,
      },
    ];

    expect(resolverNit4x1000(pagos, "800197268")).toBe("800197268");
  });

  it("devuelve null cuando el fallback es null y nada matchea", () => {
    expect(resolverNit4x1000([], null)).toBeNull();
  });
});
