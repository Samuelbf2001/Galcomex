/**
 * Regresión F5/CxP: `formatDate` de Cartera (fecha de factura / de pago,
 * fecha-calendario guardada a 00:00 UTC) no debe reinterpretarse en otra
 * zona horaria (antes usaba `timeZone: "America/Bogota"`, que resta 5 horas
 * y puede mostrar un día antes en según qué caso).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDate } from "@/components/cartera/cartera-api";

describe("cartera-api formatDate (fecha-calendario)", () => {
  const tzOriginal = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  it("muestra el día guardado (00:00 UTC) sin restarle horas", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
  });

  it("null → guion largo", () => {
    expect(formatDate(null)).toBe("—");
  });
});
