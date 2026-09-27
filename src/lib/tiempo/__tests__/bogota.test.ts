import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aFechaCalendario,
  fechaCalendarioAInput,
  fechaCalendarioBogota,
  formatFechaCalendario,
  formatInstanteBogota,
  hoyBogotaISO,
} from "../bogota";

describe("fechas-calendario CxP v2 (§D.7, R17)", () => {
  it("hoyBogotaISO: a las 23:29 de Bogotá del 23-sep sigue siendo \"2026-09-23\" (N2)", () => {
    // 2026-09-24T04:29Z = 2026-09-23 23:29 Bogotá
    expect(hoyBogotaISO(new Date("2026-09-24T04:29:00.000Z"))).toBe("2026-09-23");
    // 19:00 de Bogotá (00:00Z del día siguiente): antes proponía mañana
    expect(hoyBogotaISO(new Date("2026-09-24T00:00:00.000Z"))).toBe("2026-09-23");
    expect(hoyBogotaISO(new Date("2026-09-24T05:00:00.000Z"))).toBe("2026-09-24");
  });

  it("\"2026-09-10\" se guarda a 00:00 UTC y se muestra 10/09/2026 (N1: antes salía 09/09)", () => {
    const d = aFechaCalendario("2026-09-10");
    expect(d.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(formatFechaCalendario(d)).toBe("10/09/2026");
    expect(formatFechaCalendario("2026-09-10")).toBe("10/09/2026");
    expect(formatFechaCalendario("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
  });

  it("aFechaCalendario: ISO a medianoche UTC se respeta; otro instante → día en Bogotá", () => {
    expect(aFechaCalendario("2026-09-10T00:00:00.000Z").toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(aFechaCalendario(new Date("2026-09-10T00:00:00.000Z")).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    // 05:00Z = medianoche en Bogotá (un Date armado con la hora local del navegador)
    expect(aFechaCalendario("2026-09-10T05:00:00.000Z").toISOString()).toBe("2026-09-10T00:00:00.000Z");
    // 23:30 de Bogotá del 10-sep
    expect(aFechaCalendario(new Date("2026-09-11T04:30:00.000Z")).toISOString()).toBe(
      "2026-09-10T00:00:00.000Z",
    );
    expect(aFechaCalendario(" 2026-02-28 ").toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("aFechaCalendario rechaza fechas imposibles o texto", () => {
    expect(() => aFechaCalendario("2026-02-30")).toThrow(RangeError);
    expect(() => aFechaCalendario("mañana")).toThrow(RangeError);
    expect(() => aFechaCalendario(new Date("x"))).toThrow(RangeError);
  });

  it("formatFechaCalendario larga y valores vacíos", () => {
    expect(formatFechaCalendario("2026-09-10", "larga")).toBe("10 de septiembre de 2026");
    expect(formatFechaCalendario(null)).toBe("");
    expect(formatFechaCalendario(undefined)).toBe("");
    expect(formatFechaCalendario("no es fecha")).toBe("");
  });

  it("fechaCalendarioAInput: \"YYYY-MM-DD\" del día en UTC", () => {
    expect(fechaCalendarioAInput(new Date("2026-09-10T00:00:00.000Z"))).toBe("2026-09-10");
    expect(fechaCalendarioAInput("2026-09-10")).toBe("2026-09-10");
    expect(fechaCalendarioAInput("2026-09-10T00:00:00.000Z")).toBe("2026-09-10");
    expect(fechaCalendarioAInput(null)).toBe("");
    expect(fechaCalendarioAInput("x")).toBe("");
  });
});

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

describe("formatInstanteBogota — instantes reales (anulación de un bloque)", () => {
  it("las 20:00 de Bogotá del 20-sep (01:00Z del 21) se muestran 20/09/2026, no 21/09", () => {
    expect(formatInstanteBogota("2026-09-21T01:00:00.000Z")).toBe("20/09/2026");
    expect(formatInstanteBogota(new Date("2026-09-21T05:00:00.000Z"))).toBe("21/09/2026");
  });

  it("vacío o inválido → \"\"", () => {
    expect(formatInstanteBogota(null)).toBe("");
    expect(formatInstanteBogota(undefined)).toBe("");
    expect(formatInstanteBogota("no es fecha")).toBe("");
  });
});

describe.each(["America/Bogota", "UTC"])(
  "tolerancia a instantes viejos (fechaEnviadoAFacturar, facturas históricas) — TZ=%s",
  (tz) => {
    const tzOriginal = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = tz;
    });

    afterEach(() => {
      process.env.TZ = tzOriginal;
      vi.useRealTimers();
    });

    it("formatFechaCalendario: a 00:00:00.000 UTC es fecha-calendario → ese día UTC", () => {
      expect(formatFechaCalendario("2026-09-10T00:00:00.000Z")).toBe("10/09/2026");
      expect(formatFechaCalendario(new Date("2026-09-10T00:00:00.000Z"))).toBe("10/09/2026");
      expect(formatFechaCalendario("2026-09-10")).toBe("10/09/2026");
    });

    it("formatFechaCalendario: un instante con hora → su día en Bogotá", () => {
      // 20:00 de Bogotá del 20-sep (01:00Z del 21): antes salía 21/09
      expect(formatFechaCalendario("2026-09-21T01:00:00.000Z")).toBe("20/09/2026");
      expect(formatFechaCalendario(new Date("2026-09-21T01:00:00.000Z"))).toBe("20/09/2026");
      expect(formatFechaCalendario("2026-09-21T01:00:00.000Z", "larga")).toBe("20 de septiembre de 2026");
      // Factura histórica guardada a las 12:00 UTC (07:00 de Bogotá)
      expect(formatFechaCalendario("2026-01-12T12:00:00.000Z")).toBe("12/01/2026");
      // Anclaje viejo a mediodía de Bogotá (17:00Z)
      expect(formatFechaCalendario("2026-09-10T17:00:00.000Z")).toBe("10/09/2026");
      // Borde de medianoche en Bogotá (05:00Z)
      expect(formatFechaCalendario("2026-09-22T04:59:59.999Z")).toBe("21/09/2026");
      expect(formatFechaCalendario("2026-09-22T05:00:00.000Z")).toBe("22/09/2026");
      // Un milisegundo después de medianoche UTC ya es un instante
      expect(formatFechaCalendario("2026-09-10T00:00:00.001Z")).toBe("09/09/2026");
    });

    it("fechaCalendarioAInput sigue la misma regla (prellenar y comparar días)", () => {
      expect(fechaCalendarioAInput("2026-09-10T00:00:00.000Z")).toBe("2026-09-10");
      expect(fechaCalendarioAInput("2026-09-21T01:00:00.000Z")).toBe("2026-09-20");
      expect(fechaCalendarioAInput(new Date("2026-01-12T12:00:00.000Z"))).toBe("2026-01-12");
      expect(fechaCalendarioAInput("no es fecha")).toBe("");
    });

    it("lo que ahora guarda «Enviar a facturar» a las 20:00 de Bogotá sale ese mismo día", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-21T01:00:00.000Z")); // 20-sep 20:00 Bogotá

      const guardada = fechaCalendarioBogota();
      expect(guardada.toISOString()).toBe("2026-09-20T00:00:00.000Z");
      expect(formatFechaCalendario(guardada)).toBe("20/09/2026");
      expect(formatFechaCalendario(guardada.toISOString())).toBe("20/09/2026");
    });
  },
);
