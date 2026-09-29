/**
 * Tests unitarios — Generación de PDF (A3-T2)
 *
 * No requiere BD. Prueba:
 * 1. La función pura de preparación del borrador produce strings COP correctos.
 * 2. renderBorradorPdf() devuelve un Buffer no vacío con header %PDF.
 */

import { describe, it, expect } from "vitest";

import { pesos } from "@/lib/dinero";
import { $ } from "@/lib/dinero/test-utils";

import {
  prepararDatosEstadoCuentaPdf,
} from "../estado-cuenta-pdf";
import {
  prepararDatosBorradorPdf,
  renderBorradorPdf,
  type BorradorPdfDto,
} from "../borrador-pdf";

// ─── Datos del caso dorado BUN26-0026 ────────────────────────────────────────
// totalFactura = 41.868.042
// saldoAFavorCliente = 3.357.958
// saldoAFavorLM = 875.944
// (reproducidos exactamente del test dorado del motor de cálculo)

const CASO_DORADO_DTO: BorradorPdfDto = {
  consecutivoDO: "DO.BUN26-0026",
  nombreCliente: "Empresa Prueba S.A.S.",
  numFacturaSiigo: "BAQ-18288",
  fechaEmision: new Date("2026-01-15"),
  estado: "APROBADO",

  lineas: [
    { orden: 1, concepto: "Flete nacional", numSoporte: "FN-001", valor: pesos(1_000_000) },
    { orden: 2, concepto: "Impuesto DIAN", numSoporte: "DIAN-2026-001", valor: pesos(2_011_341) },
    {
      orden: 3,
      concepto: "Gastos portuarios Buenaventura",
      numSoporte: null,
      valor: pesos(30_854_000),
    },
    {
      orden: 4,
      concepto: "Almacenamiento",
      numSoporte: "ALM-0042",
      valor: pesos(2_216_233),
    },
    { orden: 5, concepto: "Transporte interno", numSoporte: "TI-009", valor: pesos(760_283) },
    { orden: 6, concepto: "Gastos varios", numSoporte: "GV-003", valor: pesos(175_787) },
    { orden: 7, concepto: "Honorarios agencia", numSoporte: "HA-2026", valor: pesos(3_500_000) },
  ],

  totalAnticipo: pesos(45_226_000),
  totalPagos: pesos(40_517_644),
  comision: pesos(200_000),
  ivaComision: pesos(76_000),
  costosBancarios: pesos(17_550),
  impuesto4x1000: pesos(180_904),
  totalFactura: pesos(41_868_042),

  saldoAFavorCliente: pesos(3_357_958),
  saldoACargoCliente: pesos(0),
  saldoAFavorLM: pesos(875_944),
  saldoACargoLM: pesos(0),
};

// ─── Tests de función pura de preparación ────────────────────────────────────

describe("prepararDatosBorradorPdf — caso dorado BUN26-0026", () => {
  const renderData = prepararDatosBorradorPdf(CASO_DORADO_DTO);

  it("totalFacturaStr es '$\\u202f41.868.042' (o equivalente COP es-CO)", () => {
    // Intl.NumberFormat es-CO puede usar espacio angosto o punto como separador
    // Verificamos que el valor numérico parseado coincida
    const sinPrefijo = renderData.totalFacturaStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("4186804200");
  });

  it("saldoAFavorClienteStr contiene '3.357.958'", () => {
    const sinPrefijo = renderData.saldoAFavorClienteStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("335795800");
  });

  it("saldoAFavorLMStr contiene '875.944'", () => {
    const sinPrefijo = renderData.saldoAFavorLMStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("87594400");
  });

  it("saldoACargoClienteStr contiene '0'", () => {
    const sinPrefijo = renderData.saldoACargoClienteStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("000");
  });

  it("totalAnticipoStr contiene '45.226.000'", () => {
    const sinPrefijo = renderData.totalAnticipoStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("4522600000");
  });

  it("comisionStr contiene '200.000'", () => {
    const sinPrefijo = renderData.comisionStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("20000000");
  });

  it("ivaComisionStr contiene '76.000'", () => {
    const sinPrefijo = renderData.ivaComisionStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("7600000");
  });

  it("impuesto4x1000Str contiene '180.904'", () => {
    const sinPrefijo = renderData.impuesto4x1000Str.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("18090400");
  });

  it("costosBancariosStr contiene '17.550'", () => {
    const sinPrefijo = renderData.costosBancariosStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("1755000");
  });

  it("consecutivoDO se preserva tal cual", () => {
    expect(renderData.consecutivoDO).toBe("DO.BUN26-0026");
  });

  it("numFacturaSiigo se preserva tal cual", () => {
    expect(renderData.numFacturaSiigo).toBe("BAQ-18288");
  });

  it("linea sin numSoporte se convierte a '—'", () => {
    const lineaSinSoporte = renderData.lineas.find(
      (l) => l.concepto === "Gastos portuarios Buenaventura",
    );
    expect(lineaSinSoporte?.numSoporte).toBe("—");
  });

  it("cantidad de líneas es correcta", () => {
    expect(renderData.lineas).toHaveLength(7);
  });
});

// ─── Test de render real a Buffer ─────────────────────────────────────────────

describe("renderBorradorPdf — genera Buffer PDF válido", () => {
  it("retorna un Buffer no vacío que empieza con %PDF", async () => {
    const buffer = await renderBorradorPdf(CASO_DORADO_DTO);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100);

    // Verificar header PDF (%PDF)
    const header = buffer.slice(0, 4).toString("ascii");
    expect(header).toBe("%PDF");
  }, 15_000); // react-pdf puede tardar en arrancar — timeout generoso en CI
});

// ─── Fase centavos: el PDF muestra los centavos reales y ",00" siempre ────────

describe("PDF con centavos (fase centavos, D-5)", () => {
  it("borrador BAQ-18385: línea 502.801,45 y total 1.487.623,45 / a cargo 69.623,45", () => {
    const data = prepararDatosBorradorPdf({
      ...CASO_DORADO_DTO,
      lineas: [{ orden: 1, concepto: "ALMACENAJE ALMACARGA FACT. FE 11298", numSoporte: "FE-11298", valor: $("502.801,45") }],
      totalFactura: $("1.487.623,45"),
      saldoAFavorCliente: 0n,
      saldoACargoCliente: $("69.623,45"),
    });
    expect(data.lineas[0]!.valorStr).toBe("$\u00a0502.801,45");
    expect(data.totalFacturaStr).toBe("$\u00a01.487.623,45");
    expect(data.saldoACargoClienteStr).toBe("$\u00a069.623,45");
    expect(data.comisionStr).toBe("$\u00a0200.000,00");
    expect(data.saldoAFavorClienteStr).toBe("$\u00a00,00");
  });

  it("estado de cuenta: montos con centavos y cruces en valor absoluto", () => {
    const data = prepararDatosEstadoCuentaPdf({
      nombreCliente: "LITOPLAS S.A.",
      nitCliente: "802009663-3",
      fechaEmision: new Date("2026-09-24"),
      facturas: [
        {
          id: "f1",
          numSiigo: "BAQ-18385",
          consecutivoDO: "DO.26-0069",
          fecha: new Date("2026-09-10"),
          totalFactura: $("1.487.623,45"),
          saldoAFavorCliente: 0n,
          saldoACargoCliente: $("69.623,45"),
          saldoAFavorLM: 0n,
          saldoACargoLM: 0n,
          fechaPagoCliente: null,
          fechaPagoLM: null,
        },
      ],
      cruceCliente: $("69.623,45"),
      cruceLM: -pesos(1_000),
      totalFacturas: 1,
    });
    expect(data.filas[0]!.totalFacturaStr).toBe("$\u00a01.487.623,45");
    expect(data.filas[0]!.saldoClienteStr).toBe("$\u00a069.623,45");
    expect(data.filas[0]!.saldoClienteEsFavor).toBe(false);
    expect(data.cruceClienteStr).toBe("$\u00a069.623,45");
    expect(data.cruceLMStr).toBe("$\u00a01.000,00");
    expect(data.cruceLMEsDeuda).toBe(false);
  });
});
