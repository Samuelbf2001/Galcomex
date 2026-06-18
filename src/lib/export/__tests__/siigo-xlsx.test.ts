/**
 * Tests unitarios para siigo-xlsx.ts (A3-T3)
 * No requieren BD — trabajan sobre DTOs construidos en el test.
 *
 * Caso dorado: DO.BUN26-0026 con valores del Excel real.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import {
  construirBorradorXlsx,
  construirRelacionFacturasXlsx,
  type BorradorDto,
  type CarteraClienteDto,
} from "../siigo-xlsx";

// ─── DTO caso dorado ──────────────────────────────────────────────────────────
// Valores del DO.BUN26-0026 (tolerancia 0)

const BORRADOR_DORADO: BorradorDto = {
  id: "test-borrador-id",
  numFacturaSiigo: "BAQ-18288",
  tramite: {
    consecutivo: "DO.BUN26-0026",
    cliente: { nombre: "LITOPLAS S.A.S." },
  },
  lineasRevision: [
    { concepto: "Declaración DIAN", numSoporte: "850100500", valor: 30_854_000n, orden: 1 },
    { concepto: "Flete terrestre", numSoporte: "FT-001", valor: 2_011_341n, orden: 2 },
    { concepto: "Gastos portuarios", numSoporte: null, valor: 1_000_000n, orden: 3 },
  ],
  comision: 200_000n,
  ivaComision: 76_000n,
  impuesto4x1000: 180_904n,
  costosBancarios: 17_550n,
  totalFactura: 41_868_042n,
  saldoAFavorCliente: 3_357_958n,
  saldoACargoCliente: 0n,
  saldoAFavorLM: 875_944n,
  saldoACargoLM: 0n,
};

// ─── Helpers para leer celdas del buffer ──────────────────────────────────────

function leerBuffer(buffer: Buffer) {
  return XLSX.read(buffer, { type: "buffer", cellDates: true });
}

function getCell(ws: XLSX.WorkSheet, addr: string): XLSX.CellObject | undefined {
  return ws[addr] as XLSX.CellObject | undefined;
}

// ─── Tests del borrador ───────────────────────────────────────────────────────

describe("construirBorradorXlsx — caso dorado DO.BUN26-0026", () => {
  it("genera un Buffer no vacío", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("el workbook tiene la hoja 'Borrador'", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    expect(wb.SheetNames).toContain("Borrador");
  });

  it("fila de cabecera de columnas contiene Concepto, Nº Soporte y Valor", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Borrador"];

    // La cabecera de columnas está en la fila 4 (índice 3, fila Excel 4)
    // Fila 1: meta DO, Fila 2: Factura SIIGO, Fila 3: vacía, Fila 4: cabecera
    const conceptoCell = getCell(ws, "A4");
    const soporteCell = getCell(ws, "B4");
    const valorCell = getCell(ws, "C4");

    expect(conceptoCell?.v).toBe("Concepto");
    expect(soporteCell?.v).toBe("Nº Soporte");
    expect(valorCell?.v).toBe("Valor");
  });

  it("TOTAL FACTURA es una celda numérica (type 'n') con valor 41868042", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Borrador"];

    // Buscar la celda con TOTAL FACTURA
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    let totalFacturaCell: XLSX.CellObject | undefined;

    for (let r = range.s.r; r <= range.e.r; r++) {
      const labelAddr = XLSX.utils.encode_cell({ r, c: 0 });
      const valueAddr = XLSX.utils.encode_cell({ r, c: 2 });
      const labelCell = getCell(ws, labelAddr);
      if (labelCell?.v === "TOTAL FACTURA") {
        totalFacturaCell = getCell(ws, valueAddr);
        break;
      }
    }

    expect(totalFacturaCell).toBeDefined();
    expect(totalFacturaCell?.t).toBe("n");
    expect(totalFacturaCell?.v).toBe(41_868_042);
  });

  it("todas las celdas de valor en líneas de revisión son números (type 'n')", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Borrador"];

    // Las 3 líneas de revisión están en filas 5, 6, 7 (índices 4, 5, 6)
    // Encabezado filas: 1(meta), 2(siigo), 3(vacía), 4(cabecera), 5,6,7(líneas)
    const lineaFilas = [5, 6, 7]; // Excel row numbers (1-indexed)
    for (const filaExcel of lineaFilas) {
      const addr = XLSX.utils.encode_cell({ r: filaExcel - 1, c: 2 }); // col C = índice 2
      const cell = getCell(ws, addr);
      expect(cell?.t).toBe("n");
      expect(typeof cell?.v).toBe("number");
    }
  });

  it("todos los valores del bloque de totales son números (type 'n')", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Borrador"];

    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    const labelsEsperados = [
      "Comisión Galcomex",
      "IVA comisión",
      "Impuesto 4x1000",
      "Costos bancarios",
      "TOTAL FACTURA",
      "Saldo a favor cliente",
      "Saldo a favor LM",
    ];

    const encontrados: string[] = [];

    for (let r = range.s.r; r <= range.e.r; r++) {
      const labelAddr = XLSX.utils.encode_cell({ r, c: 0 });
      const valueAddr = XLSX.utils.encode_cell({ r, c: 2 });
      const labelCell = getCell(ws, labelAddr);
      const valueCell = getCell(ws, valueAddr);

      if (typeof labelCell?.v === "string" && labelsEsperados.includes(labelCell.v)) {
        encontrados.push(labelCell.v);
        expect(valueCell?.t).toBe("n");
        expect(typeof valueCell?.v).toBe("number");
      }
    }

    // Verifica que se encontraron todos los labels esperados
    expect(encontrados.sort()).toEqual(labelsEsperados.sort());
  });

  it("Comisión = 200000, IVA = 76000, 4x1000 = 180904, costos = 17550", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Borrador"];

    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    const valoresPorLabel: Record<string, number> = {};

    for (let r = range.s.r; r <= range.e.r; r++) {
      const labelAddr = XLSX.utils.encode_cell({ r, c: 0 });
      const valueAddr = XLSX.utils.encode_cell({ r, c: 2 });
      const labelCell = getCell(ws, labelAddr);
      const valueCell = getCell(ws, valueAddr);
      if (typeof labelCell?.v === "string" && typeof valueCell?.v === "number") {
        valoresPorLabel[labelCell.v] = valueCell.v;
      }
    }

    expect(valoresPorLabel["Comisión Galcomex"]).toBe(200_000);
    expect(valoresPorLabel["IVA comisión"]).toBe(76_000);
    expect(valoresPorLabel["Impuesto 4x1000"]).toBe(180_904);
    expect(valoresPorLabel["Costos bancarios"]).toBe(17_550);
    expect(valoresPorLabel["TOTAL FACTURA"]).toBe(41_868_042);
    expect(valoresPorLabel["Saldo a favor cliente"]).toBe(3_357_958);
    expect(valoresPorLabel["Saldo a favor LM"]).toBe(875_944);
  });

  it("líneas de revisión respetan el orden (orden 1 antes que orden 3)", () => {
    const buf = construirBorradorXlsx(BORRADOR_DORADO);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Borrador"];

    // Fila 5 (índice 4) debe ser la primera línea (Declaración DIAN)
    const primerConcepto = getCell(ws, "A5");
    expect(primerConcepto?.v).toBe("Declaración DIAN");

    // Fila 7 (índice 6) debe ser la tercera línea (Gastos portuarios)
    const tercerConcepto = getCell(ws, "A7");
    expect(tercerConcepto?.v).toBe("Gastos portuarios");
  });
});

// ─── Tests de relación de facturas ───────────────────────────────────────────

describe("construirRelacionFacturasXlsx", () => {
  const carteraDto: CarteraClienteDto = {
    facturas: [
      {
        id: "f1",
        numSiigo: "BAQ-18288",
        fecha: new Date("2026-03-15"),
        totalFactura: 41_868_042n,
        saldoAFavorCliente: 3_357_958n,
        saldoACargoCliente: 0n,
        saldoAFavorLM: 875_944n,
        saldoACargoLM: 0n,
        fechaPagoCliente: null,
        fechaPagoLM: null,
        borrador: { tramiteId: "t1", tramite: { consecutivo: "DO.BUN26-0026" } },
      },
      {
        id: "f2",
        numSiigo: "BAQ-18300",
        fecha: new Date("2026-04-10"),
        totalFactura: 10_000_000n,
        saldoAFavorCliente: 0n,
        saldoACargoCliente: 500_000n,
        saldoAFavorLM: 0n,
        saldoACargoLM: 200_000n,
        fechaPagoCliente: null,
        fechaPagoLM: null,
        borrador: { tramiteId: "t2", tramite: { consecutivo: "DO.BUN26-0027" } },
      },
    ],
    cruceCliente: 500_000n - 3_357_958n, // < 0 → a favor del cliente
    cruceLM: 200_000n - 875_944n,        // < 0 → a favor de LM
    totalFacturas: 2,
  };

  it("genera Buffer no vacío con hoja 'Relacion Facturas'", () => {
    const buf = construirRelacionFacturasXlsx(carteraDto);
    expect(buf).toBeInstanceOf(Buffer);
    const wb = leerBuffer(buf);
    expect(wb.SheetNames).toContain("Relacion Facturas");
  });

  it("cabecera tiene las 10 columnas esperadas", () => {
    const buf = construirRelacionFacturasXlsx(carteraDto);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Relacion Facturas"];

    const columnas = [
      "DO", "Factura SIIGO", "Fecha", "Total Factura",
      "Saldo a favor cliente", "Saldo a cargo cliente",
      "A cargo / A favor", "Saldo a favor LM", "Saldo a cargo LM", "Cruce LM",
    ];

    columnas.forEach((col, idx) => {
      const addr = XLSX.utils.encode_cell({ r: 0, c: idx });
      expect(ws[addr]?.v).toBe(col);
    });
  });

  it("Total Factura de la primera factura es número (type 'n') = 41868042", () => {
    const buf = construirRelacionFacturasXlsx(carteraDto);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Relacion Facturas"];

    // Fila 2 (índice 1): primera factura, columna D (índice 3) = Total Factura
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c: 3 })] as XLSX.CellObject;
    expect(cell.t).toBe("n");
    expect(cell.v).toBe(41_868_042);
  });

  it("etiqueta de cruce A favor para factura con saldoAFavorCliente > 0", () => {
    const buf = construirRelacionFacturasXlsx(carteraDto);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Relacion Facturas"];

    // Fila 2 (índice 1): columna G (índice 6) = A cargo / A favor
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c: 6 })] as XLSX.CellObject;
    expect(cell.v).toBe("A favor");
  });

  it("etiqueta de cruce A cargo para factura con saldoACargoCliente > 0", () => {
    const buf = construirRelacionFacturasXlsx(carteraDto);
    const wb = leerBuffer(buf);
    const ws = wb.Sheets["Relacion Facturas"];

    // Fila 3 (índice 2): segunda factura, columna G (índice 6)
    const cell = ws[XLSX.utils.encode_cell({ r: 2, c: 6 })] as XLSX.CellObject;
    expect(cell.v).toBe("A cargo");
  });
});
