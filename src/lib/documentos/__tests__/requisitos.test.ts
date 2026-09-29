import { describe, expect, it } from "vitest";

import { categoriaParaRequisito, textoArchivos } from "@/lib/documentos/requisitos";

describe("categoriaParaRequisito", () => {
  it("las fotos de la revisión van a Fotos de reconocimiento", () => {
    expect(categoriaParaRequisito("Fotos de la revisión de la carga")).toBe("FOTO_RECONOCIMIENTO");
  });

  it("el comprobante de pago del registro es un comprobante, no el registro", () => {
    expect(categoriaParaRequisito("Comprobante de pago del registro")).toBe("COMPROBANTE_BANCARIO");
  });

  it("el registro VUCE sin categoría propia cae en Otro", () => {
    expect(categoriaParaRequisito("Registro de importación (VUCE)")).toBe("OTRO");
  });

  it("reconoce los documentos base del DO", () => {
    expect(categoriaParaRequisito("BL / Guía")).toBe("BL");
    expect(categoriaParaRequisito("Factura comercial")).toBe("FACTURA_COMERCIAL");
    expect(categoriaParaRequisito("Packing list")).toBe("PACKING_LIST");
  });

  it("no confunde palabras que contienen 'bl'", () => {
    expect(categoriaParaRequisito("Tabla de liquidación")).toBe("OTRO");
  });
});

describe("textoArchivos", () => {
  it("singular y plural", () => {
    expect(textoArchivos(1)).toBe("1 archivo");
    expect(textoArchivos(12)).toBe("12 archivos");
  });
});
