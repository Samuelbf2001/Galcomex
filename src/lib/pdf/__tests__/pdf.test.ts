/**
 * Tests unitarios — Generación de PDF (A3-T2)
 *
 * No requiere BD. Prueba:
 * 1. La función pura de preparación del borrador produce strings COP correctos.
 * 2. renderBorradorPdf() devuelve un Buffer no vacío con header %PDF.
 */

import { describe, it, expect } from "vitest";

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
    { orden: 1, concepto: "Flete nacional", numSoporte: "FN-001", valor: 1_000_000n },
    { orden: 2, concepto: "Impuesto DIAN", numSoporte: "DIAN-2026-001", valor: 2_011_341n },
    {
      orden: 3,
      concepto: "Gastos portuarios Buenaventura",
      numSoporte: null,
      valor: 30_854_000n,
    },
    {
      orden: 4,
      concepto: "Almacenamiento",
      numSoporte: "ALM-0042",
      valor: 2_216_233n,
    },
    { orden: 5, concepto: "Transporte interno", numSoporte: "TI-009", valor: 760_283n },
    { orden: 6, concepto: "Gastos varios", numSoporte: "GV-003", valor: 175_787n },
    { orden: 7, concepto: "Honorarios agencia", numSoporte: "HA-2026", valor: 3_500_000n },
  ],

  totalAnticipo: 45_226_000n,
  totalPagos: 40_517_644n,
  comision: 200_000n,
  ivaComision: 76_000n,
  costosBancarios: 17_550n,
  impuesto4x1000: 180_904n,
  totalFactura: 41_868_042n,

  saldoAFavorCliente: 3_357_958n,
  saldoACargoCliente: 0n,
  saldoAFavorLM: 875_944n,
  saldoACargoLM: 0n,
};

// ─── Tests de función pura de preparación ────────────────────────────────────

describe("prepararDatosBorradorPdf — caso dorado BUN26-0026", () => {
  const renderData = prepararDatosBorradorPdf(CASO_DORADO_DTO);

  it("totalFacturaStr es '$\\u202f41.868.042' (o equivalente COP es-CO)", () => {
    // Intl.NumberFormat es-CO puede usar espacio angosto o punto como separador
    // Verificamos que el valor numérico parseado coincida
    const sinPrefijo = renderData.totalFacturaStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("41868042");
  });

  it("saldoAFavorClienteStr contiene '3.357.958'", () => {
    const sinPrefijo = renderData.saldoAFavorClienteStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("3357958");
  });

  it("saldoAFavorLMStr contiene '875.944'", () => {
    const sinPrefijo = renderData.saldoAFavorLMStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("875944");
  });

  it("saldoACargoClienteStr contiene '0'", () => {
    const sinPrefijo = renderData.saldoACargoClienteStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("0");
  });

  it("totalAnticipoStr contiene '45.226.000'", () => {
    const sinPrefijo = renderData.totalAnticipoStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("45226000");
  });

  it("comisionStr contiene '200.000'", () => {
    const sinPrefijo = renderData.comisionStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("200000");
  });

  it("ivaComisionStr contiene '76.000'", () => {
    const sinPrefijo = renderData.ivaComisionStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("76000");
  });

  it("impuesto4x1000Str contiene '180.904'", () => {
    const sinPrefijo = renderData.impuesto4x1000Str.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("180904");
  });

  it("costosBancariosStr contiene '17.550'", () => {
    const sinPrefijo = renderData.costosBancariosStr.replace(/[^0-9]/g, "");
    expect(sinPrefijo).toBe("17550");
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
