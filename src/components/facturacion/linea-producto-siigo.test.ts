import { describe, expect, it } from "vitest";

import {
  contarLineasSinProducto,
  lineaSinProductoSiigo,
  lineaVaASiigo,
  mensajeSinProductoSiigo,
  ocultarAvisoPorLinea,
} from "./linea-producto-siigo";

describe("linea-producto-siigo (regla pura)", () => {
  it("TERCEROS con valor > 0 y sin producto: sin producto SIIGO", () => {
    const linea = { valor: "100000", tipoFija: null, siigoProductoId: null };
    expect(lineaVaASiigo(linea, "COMISION")).toBe(true);
    expect(lineaSinProductoSiigo(linea, "COMISION")).toBe(true);
  });

  it("con producto asignado: ya no hace falta", () => {
    const linea = { valor: "100000", tipoFija: null, siigoProductoId: "p1" };
    expect(lineaSinProductoSiigo(linea, "COMISION")).toBe(false);
  });

  it("valor '0' no viaja a Siigo: sin aviso", () => {
    const linea = { valor: "0", tipoFija: null, siigoProductoId: null };
    expect(lineaVaASiigo(linea, "COMISION")).toBe(false);
    expect(lineaSinProductoSiigo(linea, "COMISION")).toBe(false);
  });

  it("valor inválido (no numérico) no viaja a Siigo: sin aviso", () => {
    const linea = { valor: "no-es-un-numero", tipoFija: null, siigoProductoId: null };
    expect(lineaVaASiigo(linea, "COMISION")).toBe(false);
    expect(lineaSinProductoSiigo(linea, "COMISION")).toBe(false);
  });

  it("IVA_COMISION en CONCEPTOS_IVA no viaja como ítem (el IVA lo liquida Siigo por línea)", () => {
    const linea = { valor: "76000", tipoFija: "IVA_COMISION", siigoProductoId: null };
    expect(lineaVaASiigo(linea, "CONCEPTOS_IVA")).toBe(false);
    expect(lineaSinProductoSiigo(linea, "CONCEPTOS_IVA")).toBe(false);
  });

  it("IVA_COMISION en COMISION sí viaja como su propia línea de ítem", () => {
    const linea = { valor: "76000", tipoFija: "IVA_COMISION", siigoProductoId: null };
    expect(lineaVaASiigo(linea, "COMISION")).toBe(true);
    expect(lineaSinProductoSiigo(linea, "COMISION")).toBe(true);
  });

  it("formato undefined usa la regla de COMISION (histórico)", () => {
    const linea = { valor: "76000", tipoFija: "IVA_COMISION", siigoProductoId: null };
    expect(lineaVaASiigo(linea, undefined)).toBe(true);
    const lineaConceptosIva = { valor: "100000", tipoFija: null, siigoProductoId: null };
    expect(lineaVaASiigo(lineaConceptosIva, undefined)).toBe(true);
  });

  it("contarLineasSinProducto suma solo las líneas que de verdad viajarían sin producto", () => {
    const lineas = [
      { valor: "100000", tipoFija: null, siigoProductoId: null }, // sin producto → cuenta
      { valor: "50000", tipoFija: null, siigoProductoId: "p1" }, // con producto → no cuenta
      { valor: "0", tipoFija: null, siigoProductoId: null }, // valor 0 → no cuenta
      { valor: "19000", tipoFija: "IVA_COMISION", siigoProductoId: null }, // excluida en CONCEPTOS_IVA → no cuenta
      { valor: "8000", tipoFija: "IMPUESTO_4X1000", siigoProductoId: null }, // sin producto → cuenta
    ];
    expect(contarLineasSinProducto(lineas, "CONCEPTOS_IVA")).toBe(2);
  });
});

describe("mensajeSinProductoSiigo / ocultarAvisoPorLinea (regla pura)", () => {
  it("FACTURADO: sin aviso, se pueda o no editar", () => {
    expect(mensajeSinProductoSiigo("FACTURADO", true)).toBeNull();
    expect(mensajeSinProductoSiigo("FACTURADO", false)).toBeNull();
    expect(ocultarAvisoPorLinea("FACTURADO")).toBe(true);
  });

  it("puedeEditar=true: siempre invita a elegir el producto, sin importar el estado", () => {
    for (const estado of ["BORRADOR", "EN_REVISION", "APROBADO", null, undefined]) {
      expect(mensajeSinProductoSiigo(estado, true)).toBe(
        "Elige el producto en cada línea marcada. Sin producto, la factura no se podrá enviar a SIIGO.",
      );
    }
  });

  it("BORRADOR o EN_REVISION sin poder editar: pide que un ADMIN asigne el producto (no se puede devolver a BORRADOR)", () => {
    expect(mensajeSinProductoSiigo("BORRADOR", false)).toBe(
      "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN que asigne el producto.",
    );
    expect(mensajeSinProductoSiigo("EN_REVISION", false)).toBe(
      "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN que asigne el producto.",
    );
  });

  it("APROBADO sin poder editar: sí existe devolución a BORRADOR, se pide a un ADMIN o REVISOR", () => {
    expect(mensajeSinProductoSiigo("APROBADO", false)).toBe(
      "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR para asignar el producto.",
    );
  });

  it("estado desconocido/ausente sin poder editar: usa el mensaje de devolución (comportamiento previo por defecto)", () => {
    expect(mensajeSinProductoSiigo(null, false)).toBe(
      "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR para asignar el producto.",
    );
    expect(mensajeSinProductoSiigo(undefined, false)).toBe(
      "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR para asignar el producto.",
    );
  });

  it("ocultarAvisoPorLinea solo es true en FACTURADO", () => {
    expect(ocultarAvisoPorLinea("BORRADOR")).toBe(false);
    expect(ocultarAvisoPorLinea("EN_REVISION")).toBe(false);
    expect(ocultarAvisoPorLinea("APROBADO")).toBe(false);
    expect(ocultarAvisoPorLinea(null)).toBe(false);
    expect(ocultarAvisoPorLinea(undefined)).toBe(false);
  });
});
