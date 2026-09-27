import { describe, expect, it } from "vitest";

import {
  actualizarFacturaProveedorSchema,
  crearFacturaProveedorSchema,
  generarPagoDesdeFacturaSchema,
  reexpresarFacturaUsdSchema,
} from "../facturas-proveedor";

const base = { proveedorNombre: "ALMACARGA", numFactura: "FE-11298", valor: "502801", fecha: "2026-03-26" };

describe("crearFacturaProveedorSchema — archivo de la factura", () => {
  it("exige el archivo cuando la factura se le cobra al cliente", () => {
    const r = crearFacturaProveedorSchema.safeParse(base);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["documentoId"]);
  });

  it("acepta un costo propio sin archivo (la clasificadora no emite factura)", () => {
    const r = crearFacturaProveedorSchema.safeParse({ ...base, proveedorNombre: "MARTHA CECILIA PRIETO", repercutible: false });
    expect(r.success).toBe(true);
  });

  it("con archivo pasa en ambos casos", () => {
    expect(crearFacturaProveedorSchema.safeParse({ ...base, documentoId: "doc1" }).success).toBe(true);
    expect(crearFacturaProveedorSchema.safeParse({ ...base, documentoId: "doc1", repercutible: false }).success).toBe(true);
  });
});

describe("crearFacturaProveedorSchema — CxP v2", () => {
  const ok = { ...base, documentoId: "doc1", beneficiarioId: "ben1" };

  it("fecha-calendario: '2026-09-10' es el 10 de septiembre a las 00:00 UTC (sin corrimiento)", () => {
    const r = crearFacturaProveedorSchema.parse({ ...ok, fecha: "2026-09-10" });
    expect(r.fecha.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("valor: solo pesos enteros > 0 (sin puntos, decimales, exponentes ni hexadecimal)", () => {
    expect(crearFacturaProveedorSchema.parse(ok).valor).toBe(502_801n);
    for (const valor of ["502.801", "502801.45", "1e6", "0x10", "0", "-5"]) {
      expect(crearFacturaProveedorSchema.safeParse({ ...ok, valor }).success).toBe(false);
    }
  });

  it("número de factura con al menos una letra o dígito ('---' no: escaparía a la llave anti-duplicado)", () => {
    expect(crearFacturaProveedorSchema.safeParse({ ...ok, numFactura: "---" }).success).toBe(false);
    expect(crearFacturaProveedorSchema.safeParse({ ...ok, numFactura: " FE- 12481 " }).data?.numFactura).toBe("FE- 12481");
  });

  it("moneda por defecto COP; USD exige valor en dólares y TRM (en centavos)", () => {
    expect(crearFacturaProveedorSchema.parse(ok).moneda).toBe("COP");
    expect(crearFacturaProveedorSchema.safeParse({ ...ok, moneda: "USD" }).success).toBe(false);
    expect(crearFacturaProveedorSchema.safeParse({ ...ok, moneda: "USD", valorOrigenCentavos: "13100" }).success).toBe(false);
    const usd = crearFacturaProveedorSchema.parse({
      ...ok,
      valor: "486076",
      moneda: "USD",
      valorOrigenCentavos: "13100",
      trmCentavos: "371050",
      fechaTrm: "2026-09-10",
    });
    expect(usd).toMatchObject({ valorOrigenCentavos: 13_100n, trmCentavos: 371_050n, confirmarValorUsd: false });
    expect(usd.fechaTrm?.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("COP no admite valor en dólares ni TRM", () => {
    expect(crearFacturaProveedorSchema.safeParse({ ...ok, trmCentavos: "371050" }).success).toBe(false);
    expect(crearFacturaProveedorSchema.safeParse({ ...ok, moneda: "COP", valorOrigenCentavos: null, trmCentavos: null }).success).toBe(true);
  });

  it("confirmaciones por defecto en false", () => {
    expect(crearFacturaProveedorSchema.parse(ok)).toMatchObject({
      confirmarPosibleDuplicado: false,
      confirmarValorUsd: false,
    });
  });

  it("beneficiarioId ausente pasa el esquema: lo rechaza el servicio con PROVEEDOR_OBLIGATORIO (422)", () => {
    expect(crearFacturaProveedorSchema.safeParse({ ...base, documentoId: "doc1" }).success).toBe(true);
  });
});

describe("actualizarFacturaProveedorSchema", () => {
  it("el PATCH completo de la pantalla (mismos datos) es válido", () => {
    const r = actualizarFacturaProveedorSchema.parse({
      beneficiarioId: "ben1",
      numFactura: "FE-11298",
      valor: "502801",
      repercutible: true,
      fecha: "2026-03-26",
      concepto: "ALMACENAJE",
    });
    expect(r.valor).toBe(502_801n);
    expect(r.fecha?.toISOString()).toBe("2026-03-26T00:00:00.000Z");
  });

  it("moneda COP explícita junto con TRM se rechaza", () => {
    expect(actualizarFacturaProveedorSchema.safeParse({ moneda: "COP", trmCentavos: "371050" }).success).toBe(false);
  });
});

describe("reexpresarFacturaUsdSchema (ADMIN)", () => {
  it("exige valor, TRM y motivo de al menos 10 caracteres", () => {
    expect(reexpresarFacturaUsdSchema.safeParse({ valor: "491000", trmCentavos: "374809", motivo: "corto" }).success).toBe(false);
    const r = reexpresarFacturaUsdSchema.parse({ valor: "491000", trmCentavos: "374809", motivo: "TRM del día del pago" });
    expect(r).toMatchObject({ valor: 491_000n, trmCentavos: 374_809n, confirmarValorUsd: false });
  });
});

describe("generarPagoDesdeFacturaSchema", () => {
  it("admite abono (monto) y comprobante opcionales; fecha como fecha-calendario", () => {
    const r = generarPagoDesdeFacturaSchema.parse({
      canalPago: "PSE",
      monto: "200000",
      documentoId: "doc1",
      fechaRealPago: "2026-09-16",
    });
    expect(r.monto).toBe(200_000n);
    expect(r.fechaRealPago?.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(generarPagoDesdeFacturaSchema.safeParse({ canalPago: "PSE", monto: "0" }).success).toBe(false);
  });
});
