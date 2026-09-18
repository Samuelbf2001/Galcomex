import { describe, expect, it } from "vitest";

import { clasificarPorNombre } from "../clasificador-nombre";

/**
 * Todos los nombres de este archivo son REALES: salen de
 * `historico-litoplas-2026/manifiesto.csv` (columnas `nombre;ext`), de las
 * 2.662 filas que el importador dejó en la categoría OTRO.
 *
 * Contra ese manifiesto el clasificador reparte así (verificado 2026-09-18):
 * CONTROL_TRAMITE 787 · FICHA_TECNICA 622 · DECLARACION_DIAN 414 ·
 * CORRESPONDENCIA 275 · ORDEN_COMPRA 195 · COMPROBANTE_BANCARIO 33 ·
 * COMPROBANTE_COMERCIO 28 · FOTO_RECONOCIMIENTO 18 · BL 5 · PACKING_LIST 3 ·
 * sin regla 282 (11 %).
 */
const CASOS: [nombre: string, ext: string, esperado: string][] = [
  // ── Categorías nuevas ──────────────────────────────────────────────────────
  ["DOCUMENTOS PARA ACEPTACION.pdf", "pdf", "CONTROL_TRAMITE"],
  ["RELACION DE DOC ENVIADOS A MOV - GUILLO.pdf", "pdf", "CONTROL_TRAMITE"],
  ["RADICADO DE DOC ORIGINALES A MOV - GUILLE.pdf", "pdf", "CONTROL_TRAMITE"],
  ["Check List I26020100 LITOPLAS SA.xlsx", "xlsx", "CONTROL_TRAMITE"],
  ["DOCUMENTOS ORIGINALES ENTREGADOS X MOVIADUANAS.pdf", "pdf", "CONTROL_TRAMITE"],
  ["ARBOL DE DOC.pdf", "pdf", "CONTROL_TRAMITE"],
  ["FICHA TECNICA 709099-0052.pdf", "pdf", "FICHA_TECNICA"],
  ["DESCRIPCION MINIMA OC38071.docx", "docx", "FICHA_TECNICA"],
  ["PARTIDA.docx", "docx", "FICHA_TECNICA"],
  ["BSTe_US2010-datasheet OC36754.pdf", "pdf", "FICHA_TECNICA"],
  ["DESCRIPCION USO Y FUNCION.xlsx", "xlsx", "FICHA_TECNICA"],
  ["Bandeja de entrada_ Karina De la hoz - Outlook.pdf", "pdf", "CORRESPONDENCIA"],
  ["Rastreo - DHL - Colombia 09-02-2026.pdf", "pdf", "CORRESPONDENCIA"],
  [
    "ARRIBO DE IMPORTACION IM027_26 - APEX - OC37872 MUESTRA SIN VALOR COMERCIAL.zip",
    "zip",
    "CORRESPONDENCIA",
  ],
  ["RE_ ARRIBO DE IMPORTACION OC36754 - OC36612 BOBST - IM011_26.eml", "eml", "CORRESPONDENCIA"],
  ["ORDEN DE COMPRA OC37872.pdf", "pdf", "ORDEN_COMPRA"],
  ["PO_OC38113_0.pdf", "pdf", "ORDEN_COMPRA"],
  ["ORDEN DE VENTA OC36612.pdf", "pdf", "ORDEN_COMPRA"],
  ["Cotizacion QUGC250168 Litoplast.pdf", "pdf", "ORDEN_COMPRA"],
  ["CONTRATO DE VENTA ASO105453.PDF", "pdf", "ORDEN_COMPRA"],

  // ── Categorías que ya existían ─────────────────────────────────────────────
  ["MERCANCIA LEVANTADA.pdf", "pdf", "DECLARACION_DIAN"],
  ["ACTA PREVIA LITOPLAS I26020100.docx", "docx", "DECLARACION_DIAN"],
  ["CARTA NO RECONOCIMIENTO ORIGINAL.pdf", "pdf", "DECLARACION_DIAN"],
  ["DOCUMENTOS PARA PRORROGA.pdf", "pdf", "DECLARACION_DIAN"],
  ["ACTA DE INSPECCION.docx", "docx", "DECLARACION_DIAN"],
  ["SWIFT 2220 31-03-2026.pdf", "pdf", "COMPROBANTE_BANCARIO"],
  ["SWITF 2070 13-02-2026.pdf", "pdf", "COMPROBANTE_BANCARIO"],
  ["ANTICIPO 50_ - 1.pdf", "pdf", "COMPROBANTE_BANCARIO"],
  ["LIC-40011878-20260519N LICENCIA SALDO PANEL.pdf", "pdf", "COMPROBANTE_COMERCIO"],
  ["BORRADOR REGISTRO DE IMPORTACION.pdf", "pdf", "COMPROBANTE_COMERCIO"],
  ["2.REPOSICION  REPO- 20260209-458 VENCE FEBRERO 09 2027.pdf", "pdf", "COMPROBANTE_COMERCIO"],
  ["FOTOGRAFIAS.pdf", "pdf", "FOTO_RECONOCIMIENTO"],
  ["26-0148 BOBST ACTA FOTOS RECONOC - OC38159.zip", "zip", "FOTO_RECONOCIMIENTO"],
  ["CARTA DE PORTE.pdf", "pdf", "BL"],
  ["QBookingconfirmation.pdf", "pdf", "BL"],
  ["lista de empaquue - PL_BL2516000236.pdf", "pdf", "PACKING_LIST"],
];

describe("clasificarPorNombre — nombres reales del histórico de Litoplas", () => {
  it.each(CASOS)("%s → %s", (nombre, ext, esperado) => {
    expect(clasificarPorNombre(nombre, ext)).toBe(esperado);
  });

  it("clasifica los 36 nombres de la muestra sin dejar ninguno sin categoría", () => {
    expect(CASOS.filter(([n, e]) => clasificarPorNombre(n, e) === null)).toEqual([]);
    expect(CASOS.length).toBeGreaterThanOrEqual(25);
  });
});

describe("clasificarPorNombre — lo que NO clasifica se queda en OTRO", () => {
  const SIN_REGLA: [string, string][] = [
    ["BR082A72260200003300.pdf", "pdf"],
    ["DO.26-0037 IM027-26 APEX.xls", "xls"],
    ["CARTA ACLARATORIA DE ATF.pdf", "pdf"],
    ["DOCUMENTOS PARA REVISION.pdf", "pdf"],
    ["ACTUATOR CATR 32BX100X1 OC36612_.pdf", "pdf"],
  ];

  it.each(SIN_REGLA)("%s → null", (nombre, ext) => {
    expect(clasificarPorNombre(nombre, ext)).toBeNull();
  });
});

describe("clasificarPorNombre — el orden de las reglas manda", () => {
  it("un certificado de origen es aduanero, no ficha técnica", () => {
    expect(clasificarPorNombre("CERTIFICADO DE ORIGEN OC38071.pdf", "pdf")).toBe("DECLARACION_DIAN");
  });

  it("un certificado de análisis sí es ficha técnica", () => {
    expect(clasificarPorNombre("CERTIFICADO DE ANALISIS LOTE 4471.pdf", "pdf")).toBe("FICHA_TECNICA");
  });

  it("'CORREO LICENCIA DE IMPTCN' gana comercio antes que correspondencia", () => {
    expect(clasificarPorNombre("CORREO LICENCIA DE IMPTCN OC39382 BOBST NORTH.pdf", "pdf")).toBe(
      "COMPROBANTE_COMERCIO",
    );
  });

  it("un correo con 'FOTOS' en el asunto va a fotos (la regla de foto es la primera)", () => {
    expect(
      clasificarPorNombre("RESPUESTA JAIME RE_ ACTA Y FOTOS DE RECONOCIMIENTO DO.26-0107.eml", "eml"),
    ).toBe("FOTO_RECONOCIMIENTO");
  });

  it("cualquier .eml sin otra señal es correspondencia", () => {
    expect(clasificarPorNombre("mensaje sin pistas.eml", "eml")).toBe("CORRESPONDENCIA");
    expect(clasificarPorNombre("mensaje sin pistas.msg", ".MSG")).toBe("CORRESPONDENCIA");
  });

  it("no importan tildes, mayúsculas ni la extensión pegada al nombre", () => {
    expect(clasificarPorNombre("Clasificación arancelaria.PDF", "pdf")).toBe("FICHA_TECNICA");
    expect(clasificarPorNombre("relación de doc enviados a mov", "pdf")).toBe("CONTROL_TRAMITE");
  });
});

describe("clasificarPorNombre — la carpeta es el último recurso", () => {
  it("usa la subcarpeta solo cuando el nombre no alcanzó", () => {
    expect(clasificarPorNombre("IMG_0042.jpg", "jpg")).toBeNull();
    expect(
      clasificarPorNombre(
        "IMG_0042.jpg",
        "jpg",
        "LITOPLAS/AÑO 2026/APEX/DO.26-0037 IM027-26 APEX/FOTOS DE RECONOCIMIENTO/IMG_0042.jpg",
      ),
    ).toBe("FOTO_RECONOCIMIENTO");
  });

  it("la carpeta no puede ganarle al nombre", () => {
    expect(
      clasificarPorNombre(
        "ORDEN DE COMPRA OC37872.pdf",
        "pdf",
        "LITOPLAS/AÑO 2026/APEX/DO.26-0037/FOTOS DE RECONOCIMIENTO/ORDEN DE COMPRA OC37872.pdf",
      ),
    ).toBe("ORDEN_COMPRA");
  });

  it("la carpeta del DO (con nombre de proveedor) no dispara nada", () => {
    expect(
      clasificarPorNombre("BR082A72260200003300.pdf", "pdf", "LITOPLAS/AÑO 2026/APEX/DO.26-0037 IM027-26 APEX MOV-I26020100/BR082A72260200003300.pdf"),
    ).toBeNull();
  });
});
