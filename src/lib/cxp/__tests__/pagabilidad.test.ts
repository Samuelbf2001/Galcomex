/**
 * Pagabilidad y advertencias (src/lib/cxp/pagabilidad.ts) — PURO.
 * Una sola función decide qué se ofrece en "Pagar en bloque" y qué acepta el
 * servidor (RF-06).
 */
import { describe, expect, it } from "vitest";

import {
  advertenciaAnticipoInsuficiente,
  advertenciaAnticipoSinVerificar,
  advertenciaCostoNoCobrable,
  advertenciaValorTransferido,
  type EntradaPagabilidad,
  evaluarPagabilidad,
} from "../pagabilidad";

const base: EntradaPagabilidad = {
  saldo: 464_077n,
  tramiteEstado: "EN_TRAMITE",
  consecutivo: "DO.BAQ26-0238",
  clienteNombre: "LITOPLAS SA",
  exigeAnticipo: true,
  tieneAnticipoAplicado: true,
  repercutible: true,
  tieneProveedor: true,
};

describe("evaluarPagabilidad", () => {
  it("factura con saldo, DO abierto, proveedor y anticipo → pagable", () => {
    expect(evaluarPagabilidad(base)).toEqual({ pagable: true, motivo: null });
  });

  it("sin saldo → SIN_SALDO (una factura pagada no se ofrece por ningún camino)", () => {
    expect(evaluarPagabilidad({ ...base, saldo: 0n })).toEqual({
      pagable: false,
      motivo: { codigo: "SIN_SALDO", mensaje: "Pagada" },
    });
  });

  it("DO cerrado → DO_CERRADO", () => {
    expect(evaluarPagabilidad({ ...base, tramiteEstado: "CERRADO" })).toEqual({
      pagable: false,
      motivo: { codigo: "DO_CERRADO", mensaje: "DO cerrado" },
    });
  });

  it("sin ficha de proveedor → SIN_PROVEEDOR", () => {
    expect(evaluarPagabilidad({ ...base, tieneProveedor: false })).toEqual({
      pagable: false,
      motivo: { codigo: "SIN_PROVEEDOR", mensaje: "Falta el proveedor" },
    });
  });

  it("función «Sin anticipo no hay pago» encendida y DO sin anticipo → SIN_ANTICIPO con el nombre del cliente", () => {
    expect(evaluarPagabilidad({ ...base, tieneAnticipoAplicado: false })).toEqual({
      pagable: false,
      motivo: {
        codigo: "SIN_ANTICIPO",
        mensaje: "Sin anticipo aplicado (función encendida para LITOPLAS SA)",
      },
    });
  });

  it("sin anticipo pero la función apagada (empresa a crédito) → pagable", () => {
    expect(evaluarPagabilidad({ ...base, tieneAnticipoAplicado: false, exigeAnticipo: false }).pagable).toBe(true);
  });

  it("sin anticipo pero costo propio no repercutible → pagable (no se le cobra al cliente)", () => {
    expect(evaluarPagabilidad({ ...base, tieneAnticipoAplicado: false, repercutible: false }).pagable).toBe(true);
  });

  it("sin anticipo pero registro histórico de conciliación → pagable", () => {
    expect(evaluarPagabilidad({ ...base, tieneAnticipoAplicado: false, esHistorico: true }).pagable).toBe(true);
  });

  it("orden de motivos: sin saldo antes que DO cerrado; DO cerrado antes que proveedor y anticipo", () => {
    expect(
      evaluarPagabilidad({ ...base, saldo: 0n, tramiteEstado: "CERRADO", tieneProveedor: false }).motivo?.codigo,
    ).toBe("SIN_SALDO");
    expect(
      evaluarPagabilidad({ ...base, tramiteEstado: "CERRADO", tieneProveedor: false, tieneAnticipoAplicado: false })
        .motivo?.codigo,
    ).toBe("DO_CERRADO");
    expect(evaluarPagabilidad({ ...base, tieneProveedor: false, tieneAnticipoAplicado: false }).motivo?.codigo).toBe(
      "SIN_PROVEEDOR",
    );
  });
});

describe("advertencias (no bloquean)", () => {
  const doBase = { tramiteId: "t1", consecutivo: "DO.BAQ26-0238", anio: 2026, numero: 238 };

  it("anticipo insuficiente: 'El DO 26-0238 queda en −$161.377: Galcomex pone la diferencia.'", () => {
    expect(advertenciaAnticipoInsuficiente({ ...doBase, saldoDespues: -161_377n })).toEqual({
      codigo: "ANTICIPO_INSUFICIENTE",
      tramiteId: "t1",
      consecutivo: "DO.BAQ26-0238",
      faltante: 161_377n,
      mensaje: "El DO 26-0238 queda en −$161.377: Galcomex pone la diferencia.",
    });
    expect(advertenciaAnticipoInsuficiente({ ...doBase, saldoDespues: 0n })).toBeNull();
    expect(advertenciaAnticipoInsuficiente({ ...doBase, saldoDespues: 390_923n })).toBeNull();
  });

  it("anticipo sin verificar", () => {
    expect(advertenciaAnticipoSinVerificar({ ...doBase, numero: 255 }).mensaje).toBe(
      "El anticipo del DO 26-0255 aún no está verificado por el banco.",
    );
  });

  it("valor transferido distinto (D-2): avisa solo si se informó y no cuadra", () => {
    expect(advertenciaValorTransferido(null, 1_358_815n)).toBeNull();
    expect(advertenciaValorTransferido(undefined, 1_358_815n)).toBeNull();
    expect(advertenciaValorTransferido(1_358_815n, 1_358_815n)).toBeNull();
    expect(advertenciaValorTransferido(1_362_715n, 1_358_815n)).toEqual({
      codigo: "VALOR_TRANSFERIDO_DISTINTO",
      diferencia: 3_900n,
      mensaje: "No coincide con lo que salió del banco ($1.362.715): revisa antes de guardar.",
    });
  });

  it("costo no cobrable (D-1)", () => {
    expect(advertenciaCostoNoCobrable({ ...doBase, estadoBorrador: "FACTURADO" }).mensaje).toBe(
      "El DO 26-0238 ya tiene la factura de venta facturada: este costo ya no se le puede cobrar.",
    );
    expect(advertenciaCostoNoCobrable({ ...doBase, estadoBorrador: "APROBADO" }).mensaje).toContain("aprobada");
  });
});
