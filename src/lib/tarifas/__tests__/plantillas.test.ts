import { describe, expect, it } from "vitest";

import { CONCEPTOS_VENTA_DEMO, PLANTILLAS_TARIFARIO } from "../plantillas";

// B2 (22-sep): "Arrancar desde" muestra de quién es cada plantilla.
describe("PLANTILLAS_TARIFARIO — cliente de cada propuesta (B2)", () => {
  it("toda plantilla trae un cliente no vacío", () => {
    for (const p of PLANTILLAS_TARIFARIO) {
      expect(p.cliente.trim().length, `${p.codigo} sin cliente`).toBeGreaterThan(0);
    }
  });

  it("las tres plantillas de Litoplas comparten el mismo cliente", () => {
    const litoplas = PLANTILLAS_TARIFARIO.filter((p) => p.codigo.startsWith("LITOPLAS_"));
    expect(litoplas).toHaveLength(3);
    expect(litoplas.every((p) => p.cliente === "Litoplas")).toBe(true);
  });

  it("CW Asia y Polyrec Zona Franca tienen su propio cliente", () => {
    expect(PLANTILLAS_TARIFARIO.find((p) => p.codigo === "CW_ASIA_2026")?.cliente).toBe("CW Asia");
    expect(PLANTILLAS_TARIFARIO.find((p) => p.codigo === "POLYREC_ZF_2026")?.cliente).toBe("Polyrec Zona Franca");
  });
});

// B5 (22-sep): las 4 notas internas que traían las plantillas se borraron
// (el owner decidió eliminarlas, no solo dejar de imprimirlas).
describe("PLANTILLAS_TARIFARIO — sin notas internas (B5)", () => {
  it("ningún ítem de plantilla trae ya una nota (eran recordatorios internos)", () => {
    for (const p of PLANTILLAS_TARIFARIO) {
      for (const item of p.items) {
        expect(item.notas, `${p.codigo} · ${item.concepto} todavía tiene nota`).toBeNull();
      }
    }
  });
});

// B1 (22-sep): el select de conceptos en ItemModal solo ofrece conceptos
// ACTIVOS del catálogo; si una plantilla usara un código que no está ahí, el
// seed (`scripts/seed-conceptos-venta.ts`, fuente `CONCEPTOS_VENTA_DEMO`) no
// lo crearía y el ítem quedaría huérfano.
describe("PLANTILLAS_TARIFARIO — todo concepto existe en el catálogo (B1)", () => {
  it("cada código de concepto usado en una plantilla está en CONCEPTOS_VENTA_DEMO", () => {
    const codigosCatalogo = new Set(CONCEPTOS_VENTA_DEMO.map((c) => c.concepto));
    const faltantes: string[] = [];

    for (const p of PLANTILLAS_TARIFARIO) {
      for (const item of p.items) {
        if (!codigosCatalogo.has(item.concepto)) {
          faltantes.push(`${p.codigo} · ${item.concepto}`);
        }
      }
    }

    expect(faltantes, `Conceptos de plantilla sin fila en el catálogo:\n${faltantes.join("\n")}`).toEqual([]);
  });
});
