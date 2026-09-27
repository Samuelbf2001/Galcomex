import { describe, expect, it } from "vitest";

import { MOTIVOS_REVISION_PAGO } from "@/lib/calculations/pagos-cobrables";

import { ROLES_VEN_PAGOS_POR_REVISAR, pagosPorRevisarDesdeAuditoria } from "../pagos-por-revisar";

describe("pagosPorRevisarDesdeAuditoria", () => {
  it("convierte la lista guardada en la auditoría (BigInt como texto) y descarta lo mal formado", () => {
    expect(
      pagosPorRevisarDesdeAuditoria([
        {
          pagoId: "p-1",
          concepto: "Pago Ascinter",
          numSoporte: "FE-77",
          valor: "1200000",
          sumaFacturas: "200000",
          cobrable: "0",
          noCobrable: "1200000",
          motivo: "SOBRANTE_NO_COBRADO",
        },
        {
          pagoId: "p-2",
          concepto: 5,
          numSoporte: null,
          valor: 800_000,
          sumaFacturas: "1300000",
          cobrable: "500000",
          noCobrable: "300000",
          motivo: "OTRO_MOTIVO",
        },
        { pagoId: "p-3", valor: "1.5", sumaFacturas: "1", cobrable: "1", noCobrable: "0" },
        { valor: "1", sumaFacturas: "1", cobrable: "1", noCobrable: "0" },
        null,
        "texto",
      ]),
    ).toEqual([
      {
        pagoId: "p-1",
        concepto: "Pago Ascinter",
        numSoporte: "FE-77",
        valor: 1_200_000n,
        sumaFacturas: 200_000n,
        cobrable: 0n,
        noCobrable: 1_200_000n,
        motivo: "SOBRANTE_NO_COBRADO",
      },
      {
        pagoId: "p-2",
        concepto: "",
        numSoporte: null,
        valor: 800_000n,
        sumaFacturas: 1_300_000n,
        cobrable: 500_000n,
        noCobrable: 300_000n,
        // Motivo desconocido → null (se muestra igual, con el texto genérico).
        motivo: null,
      },
    ]);
  });

  it("lee de vuelta cada motivo conocido; sin motivo (borradores anteriores) → null", () => {
    const base = { valor: "1", sumaFacturas: "0", cobrable: "1", noCobrable: "0" };
    const leidos = pagosPorRevisarDesdeAuditoria([
      ...MOTIVOS_REVISION_PAGO.map((motivo, i) => ({ ...base, pagoId: `p-${i}`, motivo })),
      { ...base, pagoId: "p-viejo" },
    ]);
    expect(leidos.map((p) => p.motivo)).toEqual([...MOTIVOS_REVISION_PAGO, null]);
  });

  it("borradores anteriores a este cambio (sin la lista) → vacío", () => {
    expect(pagosPorRevisarDesdeAuditoria(undefined)).toEqual([]);
    expect(pagosPorRevisarDesdeAuditoria(null)).toEqual([]);
    expect(pagosPorRevisarDesdeAuditoria({})).toEqual([]);
  });

  it("solo ADMIN y REVISOR ven los pagos por revisar (nunca el SOCIO)", () => {
    expect([...ROLES_VEN_PAGOS_POR_REVISAR].sort()).toEqual(["ADMIN", "REVISOR"]);
  });
});
