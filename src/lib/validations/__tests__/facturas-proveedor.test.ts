import { describe, expect, it } from "vitest";

import { crearFacturaProveedorSchema } from "../facturas-proveedor";

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
