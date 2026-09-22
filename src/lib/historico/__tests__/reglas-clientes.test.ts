import { describe, expect, it } from "vitest";

import {
  claveSuelta,
  claveTramite,
  clasificarArchivo,
  parsearCarpeta,
} from "../../../../scripts/historico-clientes/reglas";

describe("parsearCarpeta — carpetas reales de los 11 clientes (entrega 2026-09-21)", () => {
  it("Litoplas conserva IM / MOV / proveedor", () => {
    const d = parsearCarpeta("LITOPLAS", "DO.26-0107 IM036-26 ATF MOV-I26050290")!;
    expect(d.consecutivo).toBe("DO.BAQ26-0107");
    expect(d.im).toBe("IM036-26");
    expect(d.mov).toBe("I26050290");
    expect(d.proveedor).toBe("ATF");
  });

  it("Coldex guarda su número y el cliente final como referencia", () => {
    const d = parsearCarpeta("COLDEX", "DO.26-0047 (055-26) IMP. BELLA FLOR BL. EGLV143550755099")!;
    expect(d.consecutivo).toBe("DO.BAQ26-0047");
    expect(d.ciudad).toBe("BAQ");
    expect(d.anio).toBe(2026);
    expect(d.referencia).toBe("(055-26) IMP. BELLA FLOR BL. EGLV143550755099");
  });

  it("Sesderma Bogotá → ciudad BGT", () => {
    const d = parsearCarpeta("SESDERMA", "DO.BGT26-0022 FACT.2026-69")!;
    expect(d.consecutivo).toBe("DO.BGT26-0022");
    expect(d.ciudad).toBe("BGT");
  });

  it("años viejos y DOs en curso", () => {
    expect(parsearCarpeta("POLYREC ZF", "DO.CTG25-0311 DTA POLYREC ZF BL M25EXL45739COCTG")!.consecutivo).toBe("DO.CTG25-0311");
    expect(parsearCarpeta("COLDEX", "DO.25-0307 (1370-25) DISTRIBUIDORA LAMINAS")!.anio).toBe(2025);
    expect(parsearCarpeta("PIERCO", "DO.26-0XXX FACT. CIA26090125")!.consecutivo).toBe("");
    expect(parsearCarpeta("COLDEX", "DO.EXP26-0001 (003-26) SAE")).toBeNull();
  });
});

describe("clasificarArchivo — nombres reales que las reglas de Litoplas no cubrían", () => {
  const casos: [string[], string, string][] = [
    [[], "1003977028 ALMACENAJE HASTA 15-05-2026.pdf", "FACTURA_PROVEEDOR"],
    [[], "FACTURA MSC FLP919393.pdf", "FACTURA_PROVEEDOR"],
    [["FACTURAS MSC"], "cualquier cosa.pdf", "FACTURA_PROVEEDOR"],
    [[], "FACTURA DE MANEJO 7461.pdf", "FACTURA_PROVEEDOR"],
    [[], "ROP PAGADO 4820260300797652.pdf", "COMPROBANTE_COMERCIO"],
    [[], "RECIBO OFICIAL.pdf", "COMPROBANTE_COMERCIO"],
    [[], "CARTA 12 05 MCIT_PL183.pdf", "COMPROBANTE_COMERCIO"],
    [[], "CERT INTEGRACION 928-603607.pdf", "DECLARACION_DIAN"],
    [[], "FMM PRE-APROBADO 26-0002.pdf", "DECLARACION_DIAN"],
    [[], "BGT26-0024-1.EDI", "DECLARACION_DIAN"],
    [[], "CONSULTA DE INVENTARIOS.pdf", "CONTROL_TRAMITE"],
    [[], "ARBOL DE DOC.pdf", "CONTROL_TRAMITE"],
    [[], "PZFN 2651.pdf", "SOPORTE_FACTURACION"],
    [[], "CIRCULAR No MJD-CIR26-0001-SCF-0100 para cosmeticos.pdf", "FICHA_TECNICA"],
    [[], "ArrivalNotice_MEDUW9093214.pdf", "CORRESPONDENCIA"],
    [[], "PEDIDO 4500081837.pdf", "ORDEN_COMPRA"],
    [[], "Comprobante_PagoPSE_05_05_2026_10_33_02.pdf", "COMPROBANTE_COMERCIO"],
    [[], "PAGO CMA-CMG COLOMBIA SAS.pdf", "COMPROBANTE_BANCARIO"],
    [[], "PL.pdf", "PACKING_LIST"],
    [[], "CI + PL T01JJS002pdf.pdf", "FACTURA_COMERCIAL"],
    [["DIM Y DAV CON LEVANTE"], "3.pdf", "DECLARACION_DIAN"],
    [["REGISTRO FOTOGRAFICO"], "IMG_0001.jpeg", "FOTO_RECONOCIMIENTO"],
    [["SOPORTES DE FACTURACION"], "BAQ-18280 FEB 13-2026 DO.26-0021.pdf", "SOPORTE_FACTURACION"],
    [["RECIBOS"], "algo.pdf", "COMPROBANTE_BANCARIO"],
    [[], "116575017077450.pdf", "OTRO"],
  ];
  it.each(casos)("%j %s → %s", (subcarpetas, nombre, esperado) => {
    const ext = nombre.slice(nombre.lastIndexOf(".") + 1).toLowerCase();
    expect(clasificarArchivo(subcarpetas, nombre, ext).categoria).toBe(esperado);
  });
});

describe("claves del bucket", () => {
  it("conserva las subcarpetas del cliente debajo de la categoría y numera repetidos", () => {
    const usados = new Set<string>();
    expect(claveTramite("DO.CTG26-0067", "FACTURA_PROVEEDOR", ["FACTURAS MSC"], "FLP919393.pdf", usados)).toBe(
      "tramites/DO-CTG26-0067/FACTURA_PROVEEDOR/FACTURAS MSC/FLP919393.pdf",
    );
    expect(claveTramite("DO.CTG26-0067", "FACTURA_PROVEEDOR", ["FACTURAS MSC"], "FLP919393.pdf", usados)).toBe(
      "tramites/DO-CTG26-0067/FACTURA_PROVEEDOR/FACTURAS MSC/FLP919393 (2).pdf",
    );
  });

  it("lo que está fuera de un DO va a clientes/<CLIENTE>/…", () => {
    expect(claveSuelta("POLYREC ZF", "AÑO 2026/CONCILIACION 2025-2026/FACTURA CONCILIACION PZFN-2651.pdf")).toBe(
      "clientes/POLYREC-ZF/AÑO 2026/CONCILIACION 2025-2026/FACTURA CONCILIACION PZFN-2651.pdf",
    );
  });
});
