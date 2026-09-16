import { describe, expect, it } from "vitest";

import {
  carpetaDeConsecutivo,
  claveDestino,
  clasificar,
  esBasura,
  nombreSeguro,
  parsearCarpetaDo,
  ramaDe,
} from "../../../../scripts/historico-litoplas/reglas";

describe("histórico Litoplas — reglas puras", () => {
  describe("parsearCarpetaDo", () => {
    it("DO.26- sin ciudad es Barranquilla, con IM, MOV y proveedor", () => {
      expect(parsearCarpetaDo("DO.26-0107 IM036-26 ATF MOV-I26050290", 2026)).toEqual({
        consecutivo: "DO.BAQ26-0107",
        ciudad: "BAQ",
        numero: 107,
        im: "IM036-26",
        mov: "I26050290",
        oc: "",
        proveedor: "ATF",
      });
    });

    it("DO.CTG26- conserva la ciudad; IM del 2025", () => {
      expect(parsearCarpetaDo("DO.CTG26-0003 IM001-26 NOVELIS MOV-I25120790", 2026)).toMatchObject({
        consecutivo: "DO.CTG26-0003",
        ciudad: "CTG",
        numero: 3,
        im: "IM001-26",
        mov: "I25120790",
        proveedor: "NOVELIS",
      });
      expect(parsearCarpetaDo("DO.26-0003 IM208-25 TANK HOLDING MOV-I26010015", 2026)).toMatchObject({
        consecutivo: "DO.BAQ26-0003",
        im: "IM208-25",
        proveedor: "TANK HOLDING",
      });
    });

    it("tolera espacios dobles, OC en el nombre y sufijos", () => {
      expect(parsearCarpetaDo("DO.26-0011 IM011-26 OC36754 - OC36612 BOBST MOV -I26010036", 2026)).toMatchObject({
        consecutivo: "DO.BAQ26-0011",
        oc: "OC36754",
        mov: "I26010036",
        proveedor: "BOBST",
      });
      expect(parsearCarpetaDo("DO.26-0068  IM060-26 BOBST ITALIA MOV-I26030168- GRNTIA", 2026)).toMatchObject({
        consecutivo: "DO.BAQ26-0068",
        proveedor: "BOBST ITALIA",
      });
      expect(parsearCarpetaDo("DO.CTG26-0007 IM198-25 BOBST MOV-I26010026 MUESTRA", 2026)?.proveedor).toBe("BOBST");
    });

    it("DO en curso (0XXX) no tiene consecutivo", () => {
      const d = parsearCarpetaDo("DO.26-0XXX IM063-26 CONTINENTAL MOV-I26090XXX", 2026);
      expect(d?.consecutivo).toBe("");
      expect(d?.numero).toBe(0);
      expect(d?.im).toBe("IM063-26");
    });

    it("no reconoce carpetas que no son de DO", () => {
      expect(parsearCarpetaDo("PEDIDOS POR BAQ", 2026)).toBeNull();
      expect(parsearCarpetaDo("SOPORTES DE FACTURACION", 2026)).toBeNull();
    });
  });

  describe("clasificar", () => {
    const c = (sub: string[], nombre: string) => clasificar(sub, nombre).categoria;

    it("la subcarpeta manda", () => {
      expect(c(["DOCUMENTOS MOVIADUANAS"], "MANDATO DIAN 2026-2027.pdf")).toBe("DECLARACION_DIAN");
      expect(c(["FOTOS DE RECONOCIMIENTO"], "WhatsApp Image 2026-07-01 at 12.24.03 PM.jpeg")).toBe("FOTO_RECONOCIMIENTO");
      expect(c(["FOTOS RECONOCIMIENTO 1"], "cualquier.pdf")).toBe("FOTO_RECONOCIMIENTO");
      expect(c(["SOPORTES DE FACTURACION"], "BAQ-18626 LITOPLAS - ATF.pdf")).toBe("SOPORTE_FACTURACION");
      expect(c(["SOPORTES DE FACTURACION"], "1 PAGO FONDOS IM036 070-26 (BCO).pdf")).toBe("COMPROBANTE_BANCARIO");
      expect(c(["SOPORTES DE FACTURACION"], "FACTURA ALMACARGA FE-12104.pdf")).toBe("FACTURA_PROVEEDOR");
      expect(c(["SOPORTES DE FACTURACION"], "FACTURA SPRC FESP8292173.pdf")).toBe("FACTURA_PROVEEDOR");
      expect(c(["RIM PARA BARRA CONX ELECTRICA 035061"], "carta.pdf")).toBe("COMPROBANTE_COMERCIO");
    });

    it("en la raíz decide el nombre", () => {
      expect(c([], "FACTURA COMERCIAL.pdf")).toBe("FACTURA_COMERCIAL");
      expect(c([], "FACTURA. N. 83.pdf")).toBe("FACTURA_COMERCIAL");
      expect(c([], "Commercial Invoice 19217 - Litoplas.pdf")).toBe("FACTURA_COMERCIAL");
      expect(c([], "Original 2 - (for Consignee) - HAWB No_ I922107.pdf")).toBe("BL");
      expect(c([], "HBL draft IMTS22962.pdf")).toBe("BL");
      expect(c([], "Bill Of Lading - BFEA14708.PDF")).toBe("BL");
      expect(c([], "CARTA PORTE.pdf")).toBe("BL");
      expect(c([], "LISTA DE EMPAQUE OC38071.pdf")).toBe("PACKING_LIST");
      expect(c([], "Litoplas S.A PACKING SLIP.pdf")).toBe("PACKING_LIST");
      expect(c([], "DIM (1-9) ESTADO 50.pdf")).toBe("DECLARACION_DIAN");
      expect(c([], "DIMS Y DAVS FIRMADAS.pdf")).toBe("DECLARACION_DIAN");
      expect(c([], "MANDATO DIAN FIRMADO VENCE 10-03-2027.pdf")).toBe("DECLARACION_DIAN");
      expect(c([], "SOL DE FONDOS. 26-0107.xls")).toBe("SOPORTE_FACTURACION");
      expect(c([], "REAJUSTE DE FONDOS. CTG26-0065.xls")).toBe("SOPORTE_FACTURACION");
      expect(c([], "REG-50124853-20260627N APROBACION TOTAL.pdf")).toBe("COMPROBANTE_COMERCIO");
      expect(c([], "REPORTE PAGINA VUCE PAGO RIIM CONECTOR.pdf")).toBe("COMPROBANTE_COMERCIO");
      expect(c([], "IMG_20260911_090905.jpg")).toBe("FOTO_RECONOCIMIENTO");
      expect(c([], "FOTOS I26050290.rar")).toBe("FOTO_RECONOCIMIENTO");
    });

    it("lo que no tiene regla cae en OTRO", () => {
      expect(c([], "PO_OC38071_0.pdf")).toBe("OTRO");
      expect(c([], "Check List I26020100 LITOPLAS SA.xlsx")).toBe("OTRO");
      expect(c([], "DO.26-0107 IM036-26 EXCEL MOVIAD..xls")).toBe("OTRO");
      expect(c([], "Bandeja de entrada_ Karina De la hoz - Outlook.pdf")).toBe("OTRO");
      expect(c([], "FICHA TECNICA ACTUADOR.pdf")).toBe("OTRO");
    });
  });

  describe("basura, nombres y claves", () => {
    it("detecta basura", () => {
      expect(esBasura("Thumbs.db", 10)).toBe("archivo de sistema");
      expect(esBasura("~$TA DE PREVIA.DOCX", 162)).toBe("archivo de bloqueo de Office");
      expect(esBasura("Nuevo Documento de Microsoft Word.docx", 0)).toBe("archivo vacío");
      expect(esBasura("FACTURA.pdf", 100)).toBeNull();
    });

    it("saneado de nombres y consecutivos", () => {
      expect(nombreSeguro("  Factura   N. 83.pdf ")).toBe("Factura N. 83.pdf");
      expect(nombreSeguro("a/b\\c.pdf")).toBe("a-b-c.pdf");
      expect(nombreSeguro("EXCEL MOVIAD..xls")).toBe("EXCEL MOVIAD..xls");
      expect(carpetaDeConsecutivo("DO.BAQ26-0107")).toBe("DO-BAQ26-0107");
    });

    it("claveDestino numera los nombres repetidos dentro de la misma carpeta", () => {
      const usados = new Set<string>();
      expect(claveDestino("DO.BAQ26-0107", "BL", "GUIA.pdf", usados)).toBe("tramites/DO-BAQ26-0107/BL/GUIA.pdf");
      expect(claveDestino("DO.BAQ26-0107", "BL", "guia.pdf", usados)).toBe("tramites/DO-BAQ26-0107/BL/guia (2).pdf");
      expect(claveDestino("DO.BAQ26-0107", "BL", "GUIA.PDF", usados)).toBe("tramites/DO-BAQ26-0107/BL/GUIA (3).PDF");
      expect(claveDestino("DO.BAQ26-0107", "OTRO", "GUIA.pdf", usados)).toBe("tramites/DO-BAQ26-0107/OTRO/GUIA.pdf");
    });

    it("rama por segmentos de la ruta", () => {
      expect(ramaDe(["LITOPLAS", "AÑO 2026 MATERIA PRIMA", "PEDIDOS POR BAQ", "COSMO"])).toBe("MP-BAQ");
      expect(ramaDe(["LITOPLAS", "AÑO 2026 MATERIA PRIMA", "PEDIDOS POR CTG", "NOVELIS"])).toBe("MP-CTG");
      expect(ramaDe(["LITOPLAS", "AÑO 2026", "ATF"])).toBe("A2026");
      expect(ramaDe(["LITOPLAS", "OTRA COSA"])).toBe("OTRA");
    });
  });
});
