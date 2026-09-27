/**
 * Regresión F5/CxP: el dashboard mezcla dos tipos de fecha:
 *  - `formatDate` para fecha-calendario (fechaRef, fechaFactura: 00:00 UTC).
 *  - `formatDateTime` para instantes reales (createdAt de auditoría): se
 *    muestran en el día de Bogotá, no en el día UTC del instante.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "@/components/dashboard/dashboard-api";

describe("dashboard-api fechas", () => {
  const tzOriginal = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  it("formatDate: fecha-calendario a 00:00 UTC se muestra tal cual, no un día antes", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
  });

  it("formatDateTime: instante de las 20:00 Bogotá del 20-sep (01:00Z del 21) se muestra el 20-sep", () => {
    expect(formatDateTime("2026-09-21T01:00:00.000Z")).toBe("20/09/2026");
  });

  it("formatDate/formatDateTime: null → guion largo", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
  });
});
