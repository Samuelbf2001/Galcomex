/**
 * «Facturado» solo con factura emitida (decisión de Ernesto, 25-sep-2026) —
 * lógica pura, sin BD.
 */
import { EstadoBorrador, EstadoTramite } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  FacturaNoEmitidaError,
  MOTIVO_FORZAR_MIN,
  exigeFacturaEmitida,
  motivoValido,
} from "../factura-emitida";

const E = EstadoTramite;

describe("exigeFacturaEmitida", () => {
  it("la exige al pasar de Enviado a facturar a Facturado", () => {
    expect(exigeFacturaEmitida(E.ENVIADO_A_FACTURAR, E.FACTURADO)).toBe(true);
  });

  it("la exige si el ADMIN salta directo a Facturado o Pagado desde antes de facturar", () => {
    expect(exigeFacturaEmitida(E.ENVIADO_A_FACTURAR, E.PAGADO)).toBe(true);
    expect(exigeFacturaEmitida(E.EN_PUERTO, E.FACTURADO)).toBe(true);
    expect(exigeFacturaEmitida(E.SOLICITUD, E.PAGADO)).toBe(true);
  });

  it("cerrar (descartar una solicitud o un DO que no se factura) no la exige", () => {
    expect(exigeFacturaEmitida(E.SOLICITUD, E.CERRADO)).toBe(false);
    expect(exigeFacturaEmitida(E.ENVIADO_A_FACTURAR, E.CERRADO)).toBe(false);
  });

  it("Pagado se sigue marcando libre desde Facturado (no revisa saldo)", () => {
    expect(exigeFacturaEmitida(E.FACTURADO, E.PAGADO)).toBe(false);
    expect(exigeFacturaEmitida(E.PAGADO, E.CERRADO)).toBe(false);
  });

  it("reabrir un Cerrado hacia Facturado o Pagado no la vuelve a pedir", () => {
    expect(exigeFacturaEmitida(E.CERRADO, E.FACTURADO)).toBe(false);
    expect(exigeFacturaEmitida(E.CERRADO, E.PAGADO)).toBe(false);
  });

  it("no aplica a los estados de la operación", () => {
    expect(exigeFacturaEmitida(E.DESPACHADO, E.ENVIADO_A_FACTURAR)).toBe(false);
    expect(exigeFacturaEmitida(E.FACTURADO, E.ENVIADO_A_FACTURAR)).toBe(false);
    expect(exigeFacturaEmitida(E.SOLICITUD, E.APERTURA)).toBe(false);
  });
});

describe("motivoValido", () => {
  it(`exige al menos ${MOTIVO_FORZAR_MIN} caracteres sin contar espacios de borde`, () => {
    expect(motivoValido(undefined)).toBeNull();
    expect(motivoValido(null)).toBeNull();
    expect(motivoValido("   corto   ")).toBeNull();
    expect(motivoValido("  va en la BAQ-18701  ")).toBe("va en la BAQ-18701");
  });
});

describe("FacturaNoEmitidaError", () => {
  it("dice qué tiene el DO hoy, con código estable 422", () => {
    const sinBorrador = new FacturaNoEmitidaError({
      tramiteId: "t1",
      consecutivo: "DO.BAQ26-0301",
      estadoDestino: E.FACTURADO,
      borradores: [],
      puedeForzar: false,
    });
    expect(sinBorrador.status).toBe(422);
    expect(sinBorrador.codigo).toBe("FACTURA_NO_EMITIDA");
    expect(sinBorrador.message).toBe(
      "El DO.BAQ26-0301 no tiene factura emitida: todavía no tiene borrador de factura. " +
        "Pasa a Facturado cuando su factura salga (borrador en Facturado).",
    );

    const aprobado = new FacturaNoEmitidaError({
      tramiteId: "t1",
      consecutivo: "DO.CTG26-0210",
      estadoDestino: E.FACTURADO,
      borradores: [EstadoBorrador.APROBADO, EstadoBorrador.APROBADO],
      puedeForzar: true,
    });
    expect(aprobado.message).toContain("su borrador está aprobado, sin enviar a Siigo.");
    expect(aprobado.detalles.puedeForzar).toBe(true);
  });
});
