import { describe, expect, it } from "vitest";

import {
  debeImprimirCiudad,
  filasDeItem,
  notaAgenciamientoDeItem,
  renderTarifarioPdf,
  type TarifaItemPdfDto,
  type TarifarioPdfDto,
} from "../tarifario-pdf";

// B3 (22-sep): la ciudad de la empresa sale en el PDF cuando existe; se omite
// la línea cuando no.
describe("debeImprimirCiudad", () => {
  it("true con una ciudad real", () => {
    expect(debeImprimirCiudad("Barranquilla")).toBe(true);
  });

  it("false con null, vacío o solo espacios", () => {
    expect(debeImprimirCiudad(null)).toBe(false);
    expect(debeImprimirCiudad("")).toBe(false);
    expect(debeImprimirCiudad("   ")).toBe(false);
  });
});

const DTO_BASE: TarifarioPdfDto = {
  empresaNombre: "Empresa Prueba S.A.S.",
  empresaNit: "900123456-1",
  empresaCiudad: "Barranquilla",
  contactoNombre: "Juan Pérez",
  nombre: "Tarifas 2026 importaciones",
  alcance: "TRAMITE",
  version: 1,
  estado: "VIGENTE",
  vigenteDesde: new Date("2026-01-01T00:00:00.000Z"),
  vigenteHasta: new Date("2026-12-31T00:00:00.000Z"),
  fechaEmision: new Date("2026-01-05T00:00:00.000Z"),
  ciudades: [],
  items: [
    {
      nombrePublico: "Gastos de trámite por embarque",
      tipoCalculo: "FIJO",
      disparador: "SIEMPRE",
      unidad: "TRAMITE",
      valor: 100_000n,
      valorAdicional: null,
      porcentajeBps: null,
      minimos: null,
      conceptoCosto: null,
      tramos: null,
      aplicaIva: true,
      notas: "Valor inicial y por renovación cada mes",
      restaAgenciamiento: false,
      minimoEsDelTotal: false,
    },
  ],
};

// B4 (22-sep): `Tarifario.notas` (nota interna, p. ej. "[PLANTILLA …]") nunca
// sale en el PDF — el DTO ya no tiene ese campo, así que no hay forma de
// pasarlo por error: `TarifarioPdfDto` no lo declara (lo comprueba `tsc`).
describe("renderTarifarioPdf — genera el binario sin Tarifario.notas", () => {
  it("con ciudad: produce un PDF válido", async () => {
    const pdf = await renderTarifarioPdf(DTO_BASE);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("sin ciudad (empresa sin ciudad registrada): también produce un PDF válido", async () => {
    const pdf = await renderTarifarioPdf({ ...DTO_BASE, empresaCiudad: null });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});

// B5 (22-sep): la nota del ÍTEM (para el cliente) sí se imprime — no cambia.
describe("filasDeItem — la nota del ítem no la arma esta función (se imprime aparte)", () => {
  it("FIJO: una fila con el valor formateado", () => {
    expect(filasDeItem(DTO_BASE.items[0]!)).toEqual([
      { concepto: "Gastos de trámite por embarque", valor: "100.000,00" },
    ]);
  });
});

// B1 (Diseño A, 27-sep-2026) — resta de agenciamiento y B3 — ciudades: solo
// verifican que el PDF sigue generándose (el texto en sí no es observable sin
// parsear el binario; `filasDeItem` no cambia con `restaAgenciamiento`).
describe("Diseño A — resta de agenciamiento y ciudades no rompen el PDF", () => {
  it("con un ítem que resta el agenciamiento: produce un PDF válido", async () => {
    const pdf = await renderTarifarioPdf({
      ...DTO_BASE,
      items: [{ ...DTO_BASE.items[0]!, restaAgenciamiento: true }],
    });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("con ciudades (Bogotá): produce un PDF válido", async () => {
    const pdf = await renderTarifarioPdf({ ...DTO_BASE, ciudades: ["BGT"] });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});

// BAJO 3 (revisión de código, 28-sep-2026): la nota de agenciamiento
// distingue NETO ("el mínimo es después de restar…", el mínimo impreso ya es
// lo que cobra Galcomex) de TOTAL ("menos el agenciamiento…", el mínimo
// impreso es lo que paga el cliente en total). Solo PORCENTAJE_MIN tiene esa
// distinción; las demás formas de cálculo (sin "Tarifa mínima" en la tabla)
// siempre usan la nota genérica.
describe("notaAgenciamientoDeItem — BAJO 3", () => {
  const itemPorcentajeMin = (overrides: Partial<TarifaItemPdfDto> = {}): TarifaItemPdfDto => ({
    nombrePublico: "Asesoría",
    tipoCalculo: "PORCENTAJE_MIN",
    disparador: "SIEMPRE",
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: 20,
    minimos: { SUELTA: "305000" },
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    notas: null,
    restaAgenciamiento: true,
    minimoEsDelTotal: false,
    ...overrides,
  });

  it("PORCENTAJE_MIN modo NETO: 'el mínimo es después de restar…' (no una resta pendiente)", () => {
    expect(notaAgenciamientoDeItem(itemPorcentajeMin({ minimoEsDelTotal: false }))).toBe(
      "Asesoría: el mínimo es después de restar el agenciamiento que la agencia de aduanas le factura directamente.",
    );
  });

  it("PORCENTAJE_MIN modo TOTAL: 'menos el agenciamiento…' (el mínimo impreso es el total)", () => {
    expect(notaAgenciamientoDeItem(itemPorcentajeMin({ minimoEsDelTotal: true }))).toBe(
      "Asesoría: menos el agenciamiento que la agencia de aduanas le factura directamente.",
    );
  });

  it("POR_UNIDAD (sin 'Tarifa mínima' en la tabla): siempre la nota genérica", () => {
    const item: TarifaItemPdfDto = {
      nombrePublico: "Manejo por contenedor",
      tipoCalculo: "POR_UNIDAD",
      disparador: "SIEMPRE",
      unidad: "CONTENEDOR",
      valor: 600_000n,
      valorAdicional: null,
      porcentajeBps: null,
      minimos: null,
      conceptoCosto: null,
      tramos: null,
      aplicaIva: true,
      notas: null,
      restaAgenciamiento: true,
      minimoEsDelTotal: false,
    };
    expect(notaAgenciamientoDeItem(item)).toBe(
      "Manejo por contenedor: menos el agenciamiento que la agencia de aduanas le factura directamente.",
    );
  });

  it("PDF con un ítem PORCENTAJE_MIN + minimoEsDelTotal: produce un PDF válido", async () => {
    const pdf = await renderTarifarioPdf({ ...DTO_BASE, items: [itemPorcentajeMin({ minimoEsDelTotal: true })] });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
