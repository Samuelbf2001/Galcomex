import { describe, expect, it } from "vitest";

import { tramiteQuerySchema } from "@/lib/validations/tramites";

import { OFFSET_BOGOTA_MS, rangoDiasCalendario } from "../rango-fechas";

describe("rangoDiasCalendario", () => {
  it("sin fechas no filtra", () => {
    expect(rangoDiasCalendario(undefined, undefined, 0)).toBeNull();
  });

  it("ETA (fecha-calendario a 00:00 UTC): incluye el día «hasta» completo", () => {
    expect(rangoDiasCalendario("2026-10-01", "2026-10-02", 0)).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lt: new Date("2026-10-03T00:00:00.000Z"),
    });
  });

  it("apertura (instante): corta los días a medianoche de Bogotá", () => {
    const filtro = rangoDiasCalendario("2026-10-02", "2026-10-02", OFFSET_BOGOTA_MS);
    expect(filtro).toEqual({
      gte: new Date("2026-10-02T05:00:00.000Z"),
      lt: new Date("2026-10-03T05:00:00.000Z"),
    });
    // Un DO abierto a las 23:30 del 2-oct en Bogotá (04:30 UTC del 3) entra.
    const creado = new Date("2026-10-03T04:30:00.000Z");
    expect(creado >= filtro!.gte! && creado < filtro!.lt!).toBe(true);
  });

  it("solo «desde» o solo «hasta»", () => {
    expect(rangoDiasCalendario("2026-10-01", undefined, 0)).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(rangoDiasCalendario(undefined, "2026-10-01", 0)).toEqual({
      lt: new Date("2026-10-02T00:00:00.000Z"),
    });
  });
});

describe("tramiteQuerySchema · filtros de fecha", () => {
  it("acepta AAAA-MM-DD y rechaza fechas imposibles o con otro formato", () => {
    expect(tramiteQuerySchema.parse({ etaDesde: "2026-02-28" }).etaDesde).toBe("2026-02-28");
    expect(() => tramiteQuerySchema.parse({ etaDesde: "2026-02-30" })).toThrow();
    expect(() => tramiteQuerySchema.parse({ aperturaHasta: "02/10/2026" })).toThrow();
  });
});
