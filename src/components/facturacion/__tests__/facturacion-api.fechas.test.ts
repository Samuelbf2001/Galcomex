/**
 * Regresión F5/CxP: Facturación mezcla dos tipos de fecha:
 *  - `formatDate` para fecha-calendario (fechaFactura: 00:00 UTC).
 *  - `formatDateTime` para instantes reales (fechaAprobacion, enviadoASiigoEn):
 *    se muestran en el día de Bogotá, no en la zona del navegador ni en UTC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "@/components/facturacion/facturacion-api";

describe("facturacion-api fechas", () => {
  const tzOriginal = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  it("formatDate: fecha-calendario a 00:00 UTC se muestra tal cual", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
  });

  it("formatDateTime: instante de las 20:00 Bogotá del 20-sep (01:00Z del 21) se muestra el 20-sep", () => {
    expect(formatDateTime("2026-09-21T01:00:00.000Z")).toBe("20/09/2026");
  });

  it("formatDate/formatDateTime: vacío → guion largo", () => {
    expect(formatDate("")).toBe("—");
    expect(formatDateTime("")).toBe("—");
  });
});
