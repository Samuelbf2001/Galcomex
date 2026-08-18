/**
 * Tests de reconciliación del parser borrador-lucho.ts contra los dos
 * archivos reales de Lucho (tolerancia 0 pesos).
 *
 * Los archivos .xls son insumos de negocio reales, no se generan
 * sintéticamente. Resolución de ruta (por archivo):
 *   1. Variable de entorno (LUCHO_EXCEL_PATH / LUCHO_EXCEL_PATH_2) — para
 *      correr con una copia local que no está versionada.
 *   2. Ruta versionada por defecto dentro del repo.
 *
 * BAQ-18453 (GRUPO E PAPIS, DO.CTG26-0118) SÍ está versionado en
 * "documentos referencia /BAQ-18453 MAYO 13-2026 DO.CTG26-0118
 * G.PAPIS-LUTOSA..xls" y su suite corre siempre.
 *
 * BAQ-18512 (LITOPLAS, DO.26-0113) NO está versionado — solo existe en la
 * máquina de Samuel (históricamente en
 * "C:\Users\samue\Galcomex\excel-lucho-2.xls"). Su suite se salta
 * limpiamente (describe.skipIf) hasta que alguien consiga el archivo real y
 * lo agregue a "documentos referencia /" (o exporte LUCHO_EXCEL_PATH_2
 * apuntando a una copia local).
 *
 * IMPORTANTE: la comprobación de existencia del archivo debe pasar ANTES de
 * llamar a `parseBorradorLucho` — por eso el parseo vive en `beforeAll`
 * (que `describe.skipIf` no ejecuta cuando la suite se salta) y no en el
 * cuerpo síncrono del `describe` (que sí se ejecuta siempre, incluso
 * saltado, para poder listar los tests). Ponerlo en el cuerpo del describe
 * revienta la carga del módulo entero en máquinas sin el archivo.
 *
 * Casos dorados (ver PLAN-FLUJO-LUCHO.md §2):
 *   BAQ-18453: terceros 32.652.000 + comisión 400.000 + IVA 76.000 = total 33.128.000
 *              anticipo 35.074.500 → saldo a favor 1.946.500
 *   BAQ-18512: terceros 1.159.620 + operacionales 140.000 + IVA 26.600 − reteIVA 3.990
 *              = total 1.322.230; anticipo 1.572.000 → saldo a favor 249.770
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";

import { parseBorradorLucho, reconciliar, type BorradorLuchoParseado } from "../borrador-lucho";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/lib/excel/__tests__ → raíz del repo (4 niveles arriba)
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Resuelve la ruta de un fixture .xls: env var primero, ruta versionada de fallback. */
function resolveExcelPath(envVar: string, defaultRelativePath: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return path.join(REPO_ROOT, defaultRelativePath);
}

const EXCEL_1 = resolveExcelPath(
  "LUCHO_EXCEL_PATH",
  "documentos referencia /BAQ-18453 MAYO 13-2026 DO.CTG26-0118 G.PAPIS-LUTOSA..xls",
);

// No versionado — ver nota en el encabezado del archivo. La ruta de fallback
// intencionalmente no existe en el repo; sirve solo de documentación de qué
// nombre buscar si alguien lo consigue y quiere probarlo sin exportar la env var.
const EXCEL_2 = resolveExcelPath(
  "LUCHO_EXCEL_PATH_2",
  "documentos referencia /BAQ-18512 LITOPLAS DO.26-0113.xls",
);

const excel1Existe = existsSync(EXCEL_1);
const excel2Existe = existsSync(EXCEL_2);

// ─── BAQ-18453 — GRUPO EMPRESARIAL PAPIS SAS ─────────────────────────────────

describe.skipIf(!excel1Existe)("BAQ-18453 — GRUPO EMPRESARIAL PAPIS SAS", () => {
  let parsed!: BorradorLuchoParseado;

  beforeAll(() => {
    parsed = parseBorradorLucho(EXCEL_1);
  });

  // Cabecera
  it("extrae nombre del cliente", () => {
    expect(parsed.clienteNombre).toBe("GRUPO EMPRESARIAL PAPIS SAS");
  });

  it("extrae NIT normalizado", () => {
    expect(parsed.clienteNit).toBe("901056434-2");
  });

  it("extrae número de factura", () => {
    expect(parsed.numFactura).toBe("BAQ-18453");
  });

  it("extrae fecha correcta", () => {
    expect(parsed.fecha).toBe("2026-05-13");
  });

  it("extrae DO con ciudad CTG", () => {
    expect(parsed.do.consecutivo).toBe("CTG26-0118");
    expect(parsed.do.ciudad).toBe("CTG");
    expect(parsed.do.anio).toBe("26");
    expect(parsed.do.numero).toBe("0118");
  });

  // Terceros: 8 PSE + 3 no-PSE + 1 4x1000 = 12 líneas totales
  it("extrae 12 líneas de terceros (8 PSE + 3 no-PSE + 1 4x1000)", () => {
    expect(parsed.terceros).toHaveLength(12);
    const pse = parsed.terceros.filter((t) => t.esPse);
    const noFour = parsed.terceros.filter((t) => !t.es4x1000);
    const cuatro = parsed.terceros.filter((t) => t.es4x1000);
    expect(pse).toHaveLength(8);
    expect(noFour.filter((t) => !t.esPse)).toHaveLength(3);
    expect(cuatro).toHaveLength(1);
  });

  it("línea 4x1000 tiene valor 130.088", () => {
    const cuatro = parsed.terceros.find((t) => t.es4x1000);
    expect(cuatro).toBeDefined();
    expect(cuatro!.valor).toBe(130_088n);
  });

  it("total terceros = 32.652.000", () => {
    expect(parsed.totalTerceros).toBe(32_652_000n);
  });

  // Operacionales
  it("extrae 1 línea operacional", () => {
    expect(parsed.operacionales).toHaveLength(1);
  });

  it("total operacionales = 400.000", () => {
    expect(parsed.totalOperacionales).toBe(400_000n);
  });

  it("IVA = 76.000", () => {
    expect(parsed.iva).toBe(76_000n);
  });

  it("sin retenciones", () => {
    expect(parsed.totalRetenciones).toBe(0n);
    expect(parsed.retenciones).toHaveLength(0);
  });

  // Totales dorados
  it("TOTAL FACTURA = 33.128.000 (caso dorado)", () => {
    expect(parsed.totalFactura).toBe(33_128_000n);
  });

  it("ANTICIPO = 35.074.500", () => {
    expect(parsed.anticipo).toBe(35_074_500n);
  });

  it("SALDO A FAVOR = 1.946.500 (caso dorado)", () => {
    expect(parsed.saldoAFavor).toBe(1_946_500n);
  });

  // Reconciliación
  it("reconciliación sin discrepancias (tolerancia 0 pesos)", () => {
    const disc = reconciliar(parsed);
    expect(disc).toHaveLength(0);
  });

  // Verificar referencias de factura de proveedor
  it("extrae referencia FESP7291332 de la línea de CONTECAR", () => {
    const contecar = parsed.terceros.find(
      (t) => t.concepto.includes("CONTECAR") && t.referencias.some((r) => r.numFactura === "FESP7291332"),
    );
    expect(contecar).toBeDefined();
  });

  it("extrae referencias FL1809221 y FL1809222 de HAPAG LLOYD", () => {
    const hapag = parsed.terceros.find((t) => t.concepto.includes("HAPAG LLOYD"));
    expect(hapag).toBeDefined();
    expect(hapag!.referencias.map((r) => r.numFactura)).toContain("FL1809221");
    expect(hapag!.referencias.map((r) => r.numFactura)).toContain("FL1809222");
  });

  it("extrae referencia NVS898561 de NAVEMAR", () => {
    const navemar = parsed.terceros.find((t) => t.concepto.includes("COMODATO"));
    expect(navemar).toBeDefined();
    expect(navemar!.referencias.map((r) => r.numFactura)).toContain("NVS898561");
  });

  it("extrae referencia RP-R2607938 de DEPÓSITO NAVEMAR", () => {
    const deposito = parsed.terceros.find((t) => t.concepto.includes("DEPOSITO"));
    expect(deposito).toBeDefined();
    expect(deposito!.referencias.map((r) => r.numFactura)).toContain("RP-R2607938");
  });

  it("extrae referencia AAAR-8092 de agencia de aduanas", () => {
    const agencia = parsed.terceros.find((t) => t.concepto.includes("AGENCIA DE ADUANAS"));
    expect(agencia).toBeDefined();
    expect(agencia!.referencias.map((r) => r.numFactura)).toContain("AAAR-8092");
  });

  it("referencia CUENTA DE COBRO 26-0070 extraída", () => {
    const cobro = parsed.terceros.find((t) => t.concepto.includes("CUENTA DE COBRO"));
    expect(cobro).toBeDefined();
    expect(cobro!.referencias.map((r) => r.numFactura)).toContain("26-0070");
  });
});

// ─── BAQ-18512 — LITOPLAS S.A. ────────────────────────────────────────────────
// No versionado en el repo (ver nota de cabecera) — se salta limpiamente si
// no hay archivo disponible ni por env var ni por ruta de fallback.

describe.skipIf(!excel2Existe)("BAQ-18512 — LITOPLAS S.A.", () => {
  let parsed!: BorradorLuchoParseado;

  beforeAll(() => {
    parsed = parseBorradorLucho(EXCEL_2);
  });

  // Cabecera
  it("extrae nombre del cliente", () => {
    expect(parsed.clienteNombre).toBe("LITOPLAS S.A.");
  });

  it("extrae NIT normalizado (sin comas)", () => {
    expect(parsed.clienteNit).toBe("802009663-3");
  });

  it("extrae número de factura", () => {
    expect(parsed.numFactura).toBe("BAQ-18512");
  });

  it("extrae fecha correcta", () => {
    expect(parsed.fecha).toBe("2026-06-05");
  });

  it("extrae DO sin ciudad (ciudad = null)", () => {
    expect(parsed.do.consecutivo).toBe("26-0113");
    expect(parsed.do.ciudad).toBeNull();
    expect(parsed.do.anio).toBe("26");
    expect(parsed.do.numero).toBe("0113");
  });

  // Terceros: 1 no-PSE (USO CARGUE CONT) + 1 4x1000 = 2 líneas
  it("extrae 2 líneas de terceros (1 no-PSE + 1 4x1000)", () => {
    expect(parsed.terceros).toHaveLength(2);
    expect(parsed.terceros.filter((t) => t.esPse)).toHaveLength(0);
    expect(parsed.terceros.filter((t) => t.es4x1000)).toHaveLength(1);
  });

  it("línea 4x1000 tiene valor 4.620", () => {
    const cuatro = parsed.terceros.find((t) => t.es4x1000);
    expect(cuatro).toBeDefined();
    expect(cuatro!.valor).toBe(4_620n);
  });

  it("total terceros = 1.159.620 (incl. 4x1000)", () => {
    expect(parsed.totalTerceros).toBe(1_159_620n);
  });

  // Operacionales (3 líneas)
  it("extrae 3 líneas operacionales", () => {
    expect(parsed.operacionales).toHaveLength(3);
  });

  it("operacional REVISION DOCUMENTOS = 20.000", () => {
    const rev = parsed.operacionales.find((o) => o.concepto.includes("REVISION"));
    expect(rev).toBeDefined();
    expect(rev!.valor).toBe(20_000n);
  });

  it("operacional SISTEMATIZACION DE ARCHIVOS = 20.000", () => {
    const sist = parsed.operacionales.find((o) => o.concepto.includes("SISTEMATIZACION"));
    expect(sist).toBeDefined();
    expect(sist!.valor).toBe(20_000n);
  });

  it("operacional LOGISTICA OPERATIVA = 100.000", () => {
    const log = parsed.operacionales.find((o) => o.concepto.includes("LOGISTICA"));
    expect(log).toBeDefined();
    expect(log!.valor).toBe(100_000n);
  });

  it("total operacionales = 140.000", () => {
    expect(parsed.totalOperacionales).toBe(140_000n);
  });

  it("IVA = 26.600", () => {
    expect(parsed.iva).toBe(26_600n);
  });

  // Retenciones: RETE IVA 3.990
  it("extrae 1 retención (RETE IVA)", () => {
    expect(parsed.retenciones).toHaveLength(1);
    expect(parsed.retenciones[0]!.concepto).toMatch(/RETE IVA/i);
    expect(parsed.retenciones[0]!.valor).toBe(3_990n);
  });

  it("total retenciones = 3.990", () => {
    expect(parsed.totalRetenciones).toBe(3_990n);
  });

  // Totales dorados
  it("TOTAL FACTURA = 1.322.230 (caso dorado)", () => {
    expect(parsed.totalFactura).toBe(1_322_230n);
  });

  it("ANTICIPO = 1.572.000", () => {
    expect(parsed.anticipo).toBe(1_572_000n);
  });

  it("SALDO A FAVOR = 249.770 (caso dorado)", () => {
    expect(parsed.saldoAFavor).toBe(249_770n);
  });

  // Reconciliación
  it("reconciliación sin discrepancias (tolerancia 0 pesos)", () => {
    const disc = reconciliar(parsed);
    expect(disc).toHaveLength(0);
  });

  // Referencia de factura de proveedor
  it("extrae referencia 1003982615 de SPRB", () => {
    const sprb = parsed.terceros.find((t) => t.concepto.includes("SPRB"));
    expect(sprb).toBeDefined();
    expect(sprb!.referencias.map((r) => r.numFactura)).toContain("1003982615");
  });
});
