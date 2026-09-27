import { describe, expect, it } from "vitest";

import {
  claveIdempotenciaSchema,
  dineroCopPositivoSchema,
  dineroCopSchema,
  fechaCalendarioOpcionalSchema,
  fechaCalendarioSchema,
  motivoSchema,
} from "../comunes";

describe("fechaCalendarioSchema (CxP v2, §D.7)", () => {
  it("\"2026-09-10\" → 00:00 UTC del mismo día", () => {
    expect(fechaCalendarioSchema.parse("2026-09-10").toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("un instante de las 21:00 de Bogotá queda en ese día, no en el siguiente", () => {
    // 2026-09-11T02:00Z = 2026-09-10 21:00 Bogotá (z.coerce.date() lo corría al 11 al mostrar en UTC)
    expect(fechaCalendarioSchema.parse("2026-09-11T02:00:00.000Z").toISOString()).toBe(
      "2026-09-10T00:00:00.000Z",
    );
    expect(fechaCalendarioSchema.parse(new Date("2026-09-10T00:00:00.000Z")).toISOString()).toBe(
      "2026-09-10T00:00:00.000Z",
    );
  });

  it("rechaza texto y fechas imposibles", () => {
    expect(fechaCalendarioSchema.safeParse("2026-02-30").success).toBe(false);
    expect(fechaCalendarioSchema.safeParse("ayer").success).toBe(false);
    expect(fechaCalendarioSchema.safeParse(12).success).toBe(false);
  });

  it("versión opcional admite null y undefined", () => {
    expect(fechaCalendarioOpcionalSchema.parse(null)).toBeNull();
    expect(fechaCalendarioOpcionalSchema.parse(undefined)).toBeUndefined();
  });
});

describe("dineroCopSchema", () => {
  it("acepta dígitos, enteros seguros y bigint", () => {
    expect(dineroCopSchema.parse("464077")).toBe(464_077n);
    expect(dineroCopSchema.parse(" 464077 ")).toBe(464_077n);
    expect(dineroCopSchema.parse(464_077)).toBe(464_077n);
    expect(dineroCopSchema.parse(464_077n)).toBe(464_077n);
    expect(dineroCopSchema.parse("0")).toBe(0n);
  });

  it("rechaza puntos, decimales, signos, hexadecimal y exponentes", () => {
    for (const malo of ["464.077", "464077.5", "-1", "+1", "0x10", "1e6", "", "12 000", -1, 1.5, -1n]) {
      expect(dineroCopSchema.safeParse(malo).success).toBe(false);
    }
  });

  it("positivo rechaza 0", () => {
    expect(dineroCopPositivoSchema.safeParse("0").success).toBe(false);
    expect(dineroCopPositivoSchema.parse("1")).toBe(1n);
  });
});

describe("claveIdempotenciaSchema y motivoSchema", () => {
  it("clave = UUID", () => {
    expect(claveIdempotenciaSchema.safeParse("6f1c2b8e-1d2a-4c3b-9a8e-7f6d5c4b3a21").success).toBe(true);
    expect(claveIdempotenciaSchema.safeParse("doble-clic").success).toBe(false);
  });

  it("motivo de al menos 10 caracteres (sin contar espacios de borde)", () => {
    expect(motivoSchema.safeParse("   corto   ").success).toBe(false);
    expect(motivoSchema.parse("  Pago duplicado por error  ")).toBe("Pago duplicado por error");
  });
});
