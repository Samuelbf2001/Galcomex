/**
 * Regresión F5/CxP: `formatDate` de Ingresos (fecha del movimiento,
 * fecha-calendario guardada a 00:00 UTC) no debe reinterpretarse con
 * `timeZone: "America/Bogota"` — eso resta horas y puede mostrar el día
 * anterior.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDate } from "@/components/ingresos/ingresos-api";

describe("ingresos-api formatDate (fecha-calendario)", () => {
  const tzOriginal = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  it("muestra el día guardado (00:00 UTC) tal cual", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
  });

  it("null → guion largo", () => {
    expect(formatDate(null)).toBe("—");
  });
});
