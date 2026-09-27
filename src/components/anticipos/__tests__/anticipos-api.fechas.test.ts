/**
 * Regresión F5/CxP: `formatDate` (fecha-calendario del anticipo, guardada a
 * 00:00 UTC) NO debe reinterpretarse en la zona del navegador — antes de este
 * fix, en una zona detrás de UTC (como Bogotá) salía un día antes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDate } from "@/components/anticipos/anticipos-api";

describe("anticipos-api formatDate (fecha-calendario)", () => {
  const tzOriginal = process.env.TZ;

  beforeEach(() => {
    // Simula un navegador en Bogotá (UTC-5): el caso donde el bug se veía.
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  it("muestra el mismo día guardado (00:00 UTC), sin restar horas por la zona", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
  });

  it("no cambia de mes en el primer día de un mes", () => {
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("01/01/2026");
  });

  it("string vacío o null → cadena vacía", () => {
    expect(formatDate("")).toBe("");
  });
});
