import { describe, expect, it } from "vitest";

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
      valor: 100_000n,
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
