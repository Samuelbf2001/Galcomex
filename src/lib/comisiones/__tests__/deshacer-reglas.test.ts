import { EstadoBorrador, EstadoTramite, SiigoEnvioEstado } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { impedimentoParaDeshacer, type EstadoParaDeshacer } from "@/lib/comisiones/deshacer-reglas";

/**
 * M3 — cuándo se puede deshacer una liquidación de comisiones (reglas puras,
 * sin BD). Lo conservador: solo sin factura, sin Siigo, sin cobro y sin plata.
 */

const base: EstadoParaDeshacer = {
  estado: EstadoTramite.ENVIADO_A_FACTURAR,
  borradores: [],
  movimientos: 0,
};
const borrador = (over: Partial<EstadoParaDeshacer["borradores"][number]> = {}) => ({
  estado: EstadoBorrador.BORRADOR,
  siigoEnvioEstado: null,
  siigoDraftId: null,
  ...over,
});

describe("impedimentoParaDeshacer", () => {
  it("sin borrador, o con borradores BORRADOR / EN_REVISION, se puede deshacer", () => {
    expect(impedimentoParaDeshacer(base)).toBeNull();
    expect(impedimentoParaDeshacer({ ...base, estado: EstadoTramite.SOLICITUD })).toBeNull();
    expect(impedimentoParaDeshacer({ ...base, borradores: [borrador()] })).toBeNull();
    expect(
      impedimentoParaDeshacer({
        ...base,
        borradores: [borrador(), borrador({ estado: EstadoBorrador.EN_REVISION })],
      }),
    ).toBeNull();
  });

  it("un borrador APROBADO o FACTURADO lo impide, aunque haya otros descartables", () => {
    for (const estado of [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO]) {
      expect(impedimentoParaDeshacer({ ...base, borradores: [borrador(), borrador({ estado })] })).toContain(
        "factura aprobada o emitida",
      );
    }
  });

  it("un envío a Siigo (ENVIANDO, ENVIADO, INCIERTO o con id de borrador de Siigo) lo impide; ERROR no", () => {
    for (const siigoEnvioEstado of [
      SiigoEnvioEstado.ENVIANDO,
      SiigoEnvioEstado.ENVIADO,
      SiigoEnvioEstado.INCIERTO,
    ]) {
      expect(impedimentoParaDeshacer({ ...base, borradores: [borrador({ siigoEnvioEstado })] })).toContain("Siigo");
    }
    expect(impedimentoParaDeshacer({ ...base, borradores: [borrador({ siigoDraftId: "12345" })] })).toContain("Siigo");
    expect(
      impedimentoParaDeshacer({ ...base, borradores: [borrador({ siigoEnvioEstado: SiigoEnvioEstado.ERROR })] }),
    ).toBeNull();
  });

  it("un «Otros» marcado FACTURADO o PAGADO no se deshace; CERRADO sin factura sí (ya estaba descartado)", () => {
    for (const estado of [EstadoTramite.FACTURADO, EstadoTramite.PAGADO]) {
      expect(impedimentoParaDeshacer({ ...base, estado })).toContain("facturado o pagado");
    }
    expect(impedimentoParaDeshacer({ ...base, estado: EstadoTramite.CERRADO })).toBeNull();
  });

  it("con pagos, anticipos aplicados, facturas de proveedor o movimientos de cuenta no se deshace", () => {
    expect(impedimentoParaDeshacer({ ...base, movimientos: 1 })).toContain("pagos, anticipos o facturas de proveedor");
    expect(impedimentoParaDeshacer({ ...base, movimientos: 0 })).toBeNull();
  });
});
