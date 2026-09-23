import { afterEach, describe, expect, it, vi } from "vitest";

import { fechaCalendarioBogota } from "../bogota";

describe("fechaCalendarioBogota — F5: día calendario en Bogotá (UTC−5, sin horario de verano)", () => {
  it("de madrugada en UTC, el día en Bogotá todavía es el anterior", () => {
    // 2027-02-01 04:30Z = 2027-01-31 23:30 Bogotá
    expect(fechaCalendarioBogota(new Date("2027-02-01T04:30:00.000Z"))).toEqual(
      new Date("2027-01-31T00:00:00.000Z"),
    );
  });

  it("una vez pasan las 05:00Z, el día en Bogotá ya cambió", () => {
    // 2027-02-01 05:30Z = 2027-02-01 00:30 Bogotá
    expect(fechaCalendarioBogota(new Date("2027-02-01T05:30:00.000Z"))).toEqual(
      new Date("2027-02-01T00:00:00.000Z"),
    );
  });

  it("exactamente a las 05:00Z cae en el nuevo día (medianoche en Bogotá)", () => {
    expect(fechaCalendarioBogota(new Date("2026-09-22T05:00:00.000Z"))).toEqual(
      new Date("2026-09-22T00:00:00.000Z"),
    );
    expect(fechaCalendarioBogota(new Date("2026-09-22T04:59:59.999Z"))).toEqual(
      new Date("2026-09-21T00:00:00.000Z"),
    );
  });

  it("respeta fin de mes y de año (sin quedarse pegado en el mismo mes)", () => {
    expect(fechaCalendarioBogota(new Date("2027-01-01T02:00:00.000Z"))).toEqual(
      new Date("2026-12-31T00:00:00.000Z"),
    );
  });

  describe("por defecto usa `new Date()`", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sin argumento, cae en el día calendario de Bogotá de \"ahora\"", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-22T01:00:00.000Z")); // 2026-09-21 20:00 Bogotá

      expect(fechaCalendarioBogota()).toEqual(new Date("2026-09-21T00:00:00.000Z"));
    });
  });
});
