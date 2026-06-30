/**
 * Tests del motor de importación "GRUPO E PAPIS 2026".
 *
 * Corre 100% SIN base de datos usando dryRun=true: carga el workbook real,
 * reconcilia los conceptos contra las celdas del Excel a 0 pesos y valida los
 * casos dorados (BUN26-0026, CTG26-0118) y la omisión de CTG26-0174.
 */
import * as path from "node:path";

import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  importarWorkbookGrupoEPapis,
  type ResultadoHoja,
} from "../grupo-e-papis";

const WORKBOOK_PATH = path.join(
  process.cwd(),
  "documentos referencia ",
  "GRUPO E PAPIS 2026.xlsm",
);

function cargarWorkbook(): XLSX.WorkBook {
  return XLSX.readFile(WORKBOOK_PATH, {
    cellDates: true,
    cellFormula: true,
    cellNF: false,
    cellStyles: false,
  });
}

/** Valor calculado por el motor (lado "sistema" de la reconciliación). */
function valorSistema(hoja: ResultadoHoja, concepto: string): string {
  const fila = hoja.reconciliacion.find((f) => f.concepto === concepto);
  if (!fila) {
    throw new Error(`Concepto "${concepto}" no encontrado en ${hoja.sheetName}`);
  }
  return fila.sistema;
}

/** Valor del Excel (lo que efectivamente se persiste — fuente de verdad). */
function valorExcel(hoja: ResultadoHoja, concepto: string): string {
  const fila = hoja.reconciliacion.find((f) => f.concepto === concepto);
  if (!fila) {
    throw new Error(`Concepto "${concepto}" no encontrado en ${hoja.sheetName}`);
  }
  return fila.excel;
}

describe("importarWorkbookGrupoEPapis (dryRun, sin BD)", () => {
  const workbook = cargarWorkbook();

  it("reconcilia el caso dorado BUN26-0026 a 0 pesos", async () => {
    const reporte = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId: "test",
      usuarioId: "test",
      dryRun: true,
    });

    const hoja = reporte.hojas.find((h) => h.sheetName === "BUN26-0026");
    expect(hoja).toBeDefined();
    expect(hoja!.estado).toBe("IMPORTADO");
    expect(hoja!.cuadra).toBe(true);
    expect(hoja!.requirioOverride).toBe(false); // el motor reproduce el Excel
    expect(valorSistema(hoja!, "Saldo a favor cliente")).toBe("3357958");
  });

  it("reconcilia el caso dorado CTG26-0118 (BAQ-18453) a 0 pesos", async () => {
    const reporte = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId: "test",
      usuarioId: "test",
      dryRun: true,
    });

    const hoja = reporte.hojas.find((h) => h.sheetName === "CTG26-0118");
    expect(hoja).toBeDefined();
    expect(hoja!.estado).toBe("IMPORTADO");
    expect(hoja!.cuadra).toBe(true);
    expect(hoja!.requirioOverride).toBe(false);
    expect(valorSistema(hoja!, "TOTAL FACTURA")).toBe("33128000");
    expect(valorSistema(hoja!, "Saldo a favor cliente")).toBe("1946500");
  });

  it("omite CTG26-0174 (no facturada, factura BAQ-XXXXX)", async () => {
    const reporte = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId: "test",
      usuarioId: "test",
      dryRun: true,
    });

    const hoja = reporte.hojas.find((h) => h.sheetName === "CTG26-0174");
    expect(hoja).toBeDefined();
    expect(hoja!.estado).toBe("OMITIDO");
    expect(hoja!.cuadra).toBe(false);
  });

  it("procesa las 26 hojas DO sin errores de ejecución", async () => {
    const reporte = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId: "test",
      usuarioId: "test",
      dryRun: true,
    });

    expect(reporte.totalHojas).toBe(26);
    expect(reporte.errores).toBe(0);
    expect(reporte.omitidas).toBe(1); // CTG26-0174
  });

  it("marca con requirioOverride sólo las hojas que el motor no reproduce", async () => {
    // El motor PROPIO reproduce íntegramente estas 12 hojas (no requieren override).
    // El resto de hojas facturables tienen un TOTAL FACTURA (B46) digitado a mano
    // —y, en las de saldo a cargo, un 4x1000 con base = anticipo + |saldo a cargo|—
    // que el motor no rederiva: se persiste el valor del Excel (fuente de verdad) y
    // se marcan con requirioOverride=true para revisión/transparencia.
    const SIN_OVERRIDE = [
      "BUN26-0026",
      "BUN26-0098",
      "CTG26-0028",
      "CTG26-0033",
      "CTG26-0070",
      "CTG26-0078",
      "CTG26-0098",
      "CTG26-0106",
      "CTG26-0118",
      "CTG26-0126",
      "CTG26-0151",
      "CTG26-0169",
    ];

    const reporte = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId: "test",
      usuarioId: "test",
      dryRun: true,
    });

    // Todas las hojas facturables se importan fielmente (coinciden con el Excel).
    const importadas = reporte.hojas.filter((h) => h.estado === "IMPORTADO");
    expect(importadas).toHaveLength(25);
    expect(importadas.every((h) => h.cuadra)).toBe(true);

    const sinOverride = importadas
      .filter((h) => !h.requirioOverride)
      .map((h) => h.sheetName)
      .sort();
    expect(sinOverride).toEqual([...SIN_OVERRIDE].sort());
  });

  it("persiste el Excel (fuente de verdad) en hojas con saldo a cargo (override)", async () => {
    const reporte = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId: "test",
      usuarioId: "test",
      dryRun: true,
    });

    // CTG26-0111: el Excel digita TOTAL FACTURA = 39.215.632 (el motor calcularía
    // 32.163.000). Se importa el valor del Excel y se marca el override.
    const hoja = reporte.hojas.find((h) => h.sheetName === "CTG26-0111");
    expect(hoja).toBeDefined();
    expect(hoja!.estado).toBe("IMPORTADO");
    expect(hoja!.cuadra).toBe(true);
    expect(hoja!.requirioOverride).toBe(true);
    expect(valorExcel(hoja!, "TOTAL FACTURA")).toBe("39215632");
    expect(valorSistema(hoja!, "TOTAL FACTURA")).toBe("32163000");
  });
});
