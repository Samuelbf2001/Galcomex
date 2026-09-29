import { describe, expect, it } from "vitest";

import { pesos } from "@/lib/dinero";

import { debeImprimirCiudad, filasDeItem, renderTarifarioPdf, type TarifarioPdfDto } from "../tarifario-pdf";

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
  items: [
    {
      nombrePublico: "Gastos de trámite por embarque",
      tipoCalculo: "FIJO",
      disparador: "SIEMPRE",
      unidad: "TRAMITE",
      valor: pesos(100_000),
      valorAdicional: null,
      porcentajeBps: null,
      minimos: null,
      conceptoCosto: null,
      tramos: null,
      aplicaIva: true,
      notas: "Valor inicial y por renovación cada mes",
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

// Fase centavos: valores en centavos; mínimos y tramos (JSON en pesos texto)
// se leen con el lector tolerante y salen siempre con 2 decimales.
describe("filasDeItem — centavos", () => {
  const base = DTO_BASE.items[0]!;

  it("FIJO con centavos: 502.801,45", () => {
    expect(filasDeItem({ ...base, valor: 50_280_145n })).toEqual([
      { concepto: "Gastos de trámite por embarque", valor: "502.801,45" },
    ]);
  });

  it("PORCENTAJE_MIN: mínimos heredados (\"150000\"), con centavos (\".45\") y con \".00\"", () => {
    const filas = filasDeItem({
      ...base,
      tipoCalculo: "PORCENTAJE_MIN",
      porcentajeBps: 25,
      minimos: { SUELTA: "150000", CONTENEDOR_20: "300000.45", CONTENEDOR_40: "300000.00" },
    });
    expect(filas.map((f) => f.valor)).toEqual([
      "0,25 % sobre el valor en Aduana",
      "150.000,00",
      "300.000,45",
      "300.000,00",
    ]);
  });

  it("POR_TRAMO: tramo con centavos", () => {
    const filas = filasDeItem({
      ...base,
      tipoCalculo: "POR_TRAMO",
      unidad: "CONTENEDOR",
      aplicaIva: true,
      tramos: [
        { hasta: 1, valor: "300000" },
        { hasta: null, valor: "250000.50" },
      ],
    });
    expect(filas.map((f) => f.valor)).toEqual(["300.000,00 + IVA", "250.000,50 + IVA"]);
  });

  it("un mínimo ilegible es error visible (no se omite en silencio)", () => {
    expect(() =>
      filasDeItem({ ...base, tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 25, minimos: { SUELTA: "150.000" } }),
    ).toThrow(/ilegible/);
  });
});
