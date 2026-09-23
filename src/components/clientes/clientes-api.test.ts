import { afterEach, describe, expect, it, vi } from "vitest";
import { parsearAbrirPopup, tieneTarifarioVigenteHoy, type TarifarioVigenciaRow } from "./clientes-api";

describe("parsearAbrirPopup", () => {
  it("acepta los tres valores válidos", () => {
    expect(parsearAbrirPopup("funciones")).toBe("funciones");
    expect(parsearAbrirPopup("contacto")).toBe("contacto");
    expect(parsearAbrirPopup("tarifas")).toBe("tarifas");
  });

  it("ignora cualquier otro valor", () => {
    expect(parsearAbrirPopup("otra-cosa")).toBeNull();
    expect(parsearAbrirPopup("")).toBeNull();
    expect(parsearAbrirPopup(undefined)).toBeNull();
    expect(parsearAbrirPopup(null)).toBeNull();
  });

  it("si Next repite el parámetro y llega como lista, usa el primer valor válido", () => {
    expect(parsearAbrirPopup(["tarifas", "contacto"])).toBe("tarifas");
    expect(parsearAbrirPopup(["nope", "contacto"])).toBeNull();
    expect(parsearAbrirPopup([])).toBeNull();
  });
});

describe("tieneTarifarioVigenteHoy", () => {
  const hoy = new Date("2026-06-15T12:00:00.000Z");

  function fila(estado: string, desde: string, hasta: string): TarifarioVigenciaRow {
    return { estado, vigenteDesde: desde, vigenteHasta: hasta };
  }

  it("true cuando hay un VIGENTE cuya vigencia cubre hoy", () => {
    expect(
      tieneTarifarioVigenteHoy([fila("VIGENTE", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z")], hoy),
    ).toBe(true);
  });

  it("es inclusivo en los dos extremos de la vigencia", () => {
    expect(tieneTarifarioVigenteHoy([fila("VIGENTE", "2026-06-15T00:00:00.000Z", "2026-06-20T00:00:00.000Z")], hoy)).toBe(true);
    expect(tieneTarifarioVigenteHoy([fila("VIGENTE", "2026-06-10T00:00:00.000Z", "2026-06-15T00:00:00.000Z")], hoy)).toBe(true);
  });

  it("false cuando la vigencia ya venció", () => {
    expect(tieneTarifarioVigenteHoy([fila("VIGENTE", "2025-01-01T00:00:00.000Z", "2026-06-14T00:00:00.000Z")], hoy)).toBe(false);
  });

  it("false cuando la vigencia todavía no empieza", () => {
    expect(tieneTarifarioVigenteHoy([fila("VIGENTE", "2026-06-16T00:00:00.000Z", "2027-06-16T00:00:00.000Z")], hoy)).toBe(false);
  });

  it("false cuando el rango cubre hoy pero el estado no es VIGENTE", () => {
    expect(tieneTarifarioVigenteHoy([fila("BORRADOR", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z")], hoy)).toBe(false);
    expect(tieneTarifarioVigenteHoy([fila("VENCIDO", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z")], hoy)).toBe(false);
  });

  it("false sin tarifarios", () => {
    expect(tieneTarifarioVigenteHoy([], hoy)).toBe(false);
  });

  it("true si CUALQUIERA de varios tarifarios está vigente hoy", () => {
    expect(
      tieneTarifarioVigenteHoy(
        [
          fila("VENCIDO", "2025-01-01T00:00:00.000Z", "2025-12-31T00:00:00.000Z"),
          fila("BORRADOR", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"),
          fila("VIGENTE", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"),
        ],
        hoy,
      ),
    ).toBe(true);
  });

  it("usa la fecha actual cuando no se pasa `hoy`", () => {
    const desde = new Date();
    desde.setUTCFullYear(desde.getUTCFullYear() - 1);
    const hasta = new Date();
    hasta.setUTCFullYear(hasta.getUTCFullYear() + 1);
    expect(
      tieneTarifarioVigenteHoy([fila("VIGENTE", desde.toISOString(), hasta.toISOString())]),
    ).toBe(true);
  });

  describe("F5 — el punto ámbar usa el día calendario en Bogotá, no el instante UTC", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("vigenteHasta 2027-01-31: sigue vigente a las 23:30 Bogotá y ya no a las 00:30 Bogotá del día siguiente", () => {
      const tarifario = fila("VIGENTE", "2026-01-01T00:00:00.000Z", "2027-01-31T00:00:00.000Z");

      vi.useFakeTimers({ toFake: ["Date"] });

      // 2027-01-31 23:30 Bogotá = 2027-02-01 04:30Z
      vi.setSystemTime(new Date("2027-02-01T04:30:00.000Z"));
      expect(tieneTarifarioVigenteHoy([tarifario])).toBe(true);

      // 2027-02-01 00:30 Bogotá = 2027-02-01 05:30Z
      vi.setSystemTime(new Date("2027-02-01T05:30:00.000Z"));
      expect(tieneTarifarioVigenteHoy([tarifario])).toBe(false);
    });

    it("vigenteDesde 2026-09-22: no vigente a las 20:00 Bogotá del día anterior", () => {
      const tarifario = fila("VIGENTE", "2026-09-22T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

      vi.useFakeTimers({ toFake: ["Date"] });
      // 2026-09-21 20:00 Bogotá = 2026-09-22 01:00Z
      vi.setSystemTime(new Date("2026-09-22T01:00:00.000Z"));

      expect(tieneTarifarioVigenteHoy([tarifario])).toBe(false);
    });
  });
});
