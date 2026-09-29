/**
 * Tests de reconciliación del parser borrador-lucho.ts contra los dos
 * archivos reales de Lucho (tolerancia 0 pesos).
 *
 * Archivos de prueba:
 *   C:\Users\samue\Galcomex\excel-lucho-1.xls  → BAQ-18453 (GRUPO E PAPIS, DO.CTG26-0118)
 *   C:\Users\samue\Galcomex\excel-lucho-2.xls  → BAQ-18512 (LITOPLAS, DO.26-0113)
 *
 * Casos dorados (ver PLAN-FLUJO-LUCHO.md §2):
 *   BAQ-18453: terceros 32.652.000 + comisión 400.000 + IVA 76.000 = total 33.128.000
 *              anticipo 35.074.500 → saldo a favor 1.946.500
 *   BAQ-18512: terceros 1.159.620 + operacionales 140.000 + IVA 26.600 − reteIVA 3.990
 *              = total 1.322.230; anticipo 1.572.000 → saldo a favor 249.770
 */

import { existsSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { pesos } from "@/lib/dinero";

import { CeldaDineroInvalidaError, centavosDeCelda, parseBorradorLucho, reconciliar } from "../borrador-lucho";

const EXCEL_1 = process.env.LUCHO_EXCEL_1 ?? "C:\\Users\\samue\\Galcomex\\excel-lucho-1.xls";
const EXCEL_2 = process.env.LUCHO_EXCEL_2 ?? "C:\\Users\\samue\\Galcomex\\excel-lucho-2.xls";

const excel1Disponible = existsSync(EXCEL_1);
const excel2Disponible = existsSync(EXCEL_2);

// ─── BAQ-18453 — GRUPO EMPRESARIAL PAPIS SAS ─────────────────────────────────

describe.skipIf(!excel1Disponible)("BAQ-18453 — GRUPO EMPRESARIAL PAPIS SAS", () => {
  const parsed = excel1Disponible
    ? parseBorradorLucho(EXCEL_1)
    : (null as unknown as ReturnType<typeof parseBorradorLucho>);

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
    expect(cuatro!.valor).toBe(pesos(130_088));
  });

  it("total terceros = 32.652.000", () => {
    expect(parsed.totalTerceros).toBe(pesos(32_652_000));
  });

  // Operacionales
  it("extrae 1 línea operacional", () => {
    expect(parsed.operacionales).toHaveLength(1);
  });

  it("total operacionales = 400.000", () => {
    expect(parsed.totalOperacionales).toBe(pesos(400_000));
  });

  it("IVA = 76.000", () => {
    expect(parsed.iva).toBe(pesos(76_000));
  });

  it("sin retenciones", () => {
    expect(parsed.totalRetenciones).toBe(0n);
    expect(parsed.retenciones).toHaveLength(0);
  });

  // Totales dorados
  it("TOTAL FACTURA = 33.128.000 (caso dorado)", () => {
    expect(parsed.totalFactura).toBe(pesos(33_128_000));
  });

  it("ANTICIPO = 35.074.500", () => {
    expect(parsed.anticipo).toBe(pesos(35_074_500));
  });

  it("SALDO A FAVOR = 1.946.500 (caso dorado)", () => {
    expect(parsed.saldoAFavor).toBe(pesos(1_946_500));
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

describe.skipIf(!excel2Disponible)("BAQ-18512 — LITOPLAS S.A.", () => {
  const parsed = excel2Disponible
    ? parseBorradorLucho(EXCEL_2)
    : (null as unknown as ReturnType<typeof parseBorradorLucho>);

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
    expect(cuatro!.valor).toBe(pesos(4_620));
  });

  it("total terceros = 1.159.620 (incl. 4x1000)", () => {
    expect(parsed.totalTerceros).toBe(pesos(1_159_620));
  });

  // Operacionales (3 líneas)
  it("extrae 3 líneas operacionales", () => {
    expect(parsed.operacionales).toHaveLength(3);
  });

  it("operacional REVISION DOCUMENTOS = 20.000", () => {
    const rev = parsed.operacionales.find((o) => o.concepto.includes("REVISION"));
    expect(rev).toBeDefined();
    expect(rev!.valor).toBe(pesos(20_000));
  });

  it("operacional SISTEMATIZACION DE ARCHIVOS = 20.000", () => {
    const sist = parsed.operacionales.find((o) => o.concepto.includes("SISTEMATIZACION"));
    expect(sist).toBeDefined();
    expect(sist!.valor).toBe(pesos(20_000));
  });

  it("operacional LOGISTICA OPERATIVA = 100.000", () => {
    const log = parsed.operacionales.find((o) => o.concepto.includes("LOGISTICA"));
    expect(log).toBeDefined();
    expect(log!.valor).toBe(pesos(100_000));
  });

  it("total operacionales = 140.000", () => {
    expect(parsed.totalOperacionales).toBe(pesos(140_000));
  });

  it("IVA = 26.600", () => {
    expect(parsed.iva).toBe(pesos(26_600));
  });

  // Retenciones: RETE IVA 3.990
  it("extrae 1 retención (RETE IVA)", () => {
    expect(parsed.retenciones).toHaveLength(1);
    expect(parsed.retenciones[0]!.concepto).toMatch(/RETE IVA/i);
    expect(parsed.retenciones[0]!.valor).toBe(pesos(3_990));
  });

  it("total retenciones = 3.990", () => {
    expect(parsed.totalRetenciones).toBe(pesos(3_990));
  });

  // Totales dorados
  it("TOTAL FACTURA = 1.322.230 (caso dorado)", () => {
    expect(parsed.totalFactura).toBe(pesos(1_322_230));
  });

  it("ANTICIPO = 1.572.000", () => {
    expect(parsed.anticipo).toBe(pesos(1_572_000));
  });

  it("SALDO A FAVOR = 249.770 (caso dorado)", () => {
    expect(parsed.saldoAFavor).toBe(pesos(249_770));
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

// ─── Fase centavos: lectura de celdas ─────────────────────────────────────────

describe("centavosDeCelda — celdas del Excel de Lucho a centavos", () => {
  it("lee centavos reales y enteros heredados", () => {
    expect(centavosDeCelda(502801.45, "I12")).toBe(50_280_145n);
    expect(centavosDeCelda(130088, "I20")).toBe(pesos(130_088));
    expect(centavosDeCelda(null, "I1")).toBe(0n);
  });

  it("tolera el ruido binario de Excel (0,1 + 0,2)", () => {
    expect(centavosDeCelda(0.1 + 0.2, "I3")).toBe(30n);
  });

  it("más de 2 decimales (fórmula sin redondear) es error visible con la celda", () => {
    expect(() => centavosDeCelda(130087.648, "I20")).toThrow(CeldaDineroInvalidaError);
    expect(() => centavosDeCelda(130087.648, "I20")).toThrow(/Celda I20/);
  });
});
