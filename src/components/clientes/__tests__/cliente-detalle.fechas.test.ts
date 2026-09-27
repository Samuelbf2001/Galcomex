/**
 * Regresión «fechas un día antes»: la ficha del cliente formateaba la fecha
 * del anticipo con la zona del navegador. Un anticipo creado el 10-sep (p. ej.
 * por el sobrante de un abono), guardado a 00:00 UTC, salía 09/09 en Bogotá.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDate } from "@/components/clientes/cliente-detalle";

describe.each(["America/Bogota", "UTC"])("cliente-detalle formatDate (anticipo.fecha) — TZ=%s", (tz) => {
  const tzOriginal = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = tz;
  });

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  it("fecha-calendario a 00:00 UTC: el mismo día guardado, no el anterior", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("01/01/2026");
  });

  it("instante viejo con hora: su día en Bogotá", () => {
    expect(formatDate("2026-09-21T01:00:00.000Z")).toBe("20/09/2026");
    expect(formatDate("2026-01-12T12:00:00.000Z")).toBe("12/01/2026");
  });

  it("vacío → guion largo; texto que no es fecha se muestra tal cual", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("sin fecha")).toBe("sin fecha");
  });
});
