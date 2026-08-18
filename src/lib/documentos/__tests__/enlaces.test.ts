/**
 * Tests de los enlaces compartibles de documento (G4).
 * Funciones puras — sin BD, sin reloj real.
 */
import { describe, expect, it } from "vitest";

import {
  ENLACE_VIGENCIA_DIAS_DEFAULT,
  ENLACE_VIGENCIA_DIAS_MAX,
  calcularExpiracion,
  enlaceEsUtilizable,
  evaluarEstadoEnlace,
  generarTokenEnlace,
  normalizarVigenciaDias,
} from "../enlaces";

const AHORA = new Date("2026-08-17T12:00:00.000Z");

describe("evaluarEstadoEnlace", () => {
  it("vigente mientras no llegue la fecha de caducidad", () => {
    const enlace = { expiresAt: new Date("2026-08-18T12:00:00.000Z"), revocadoEn: null };
    expect(evaluarEstadoEnlace(enlace, AHORA)).toBe("VIGENTE");
  });

  it("expirado una vez pasada la fecha", () => {
    const enlace = { expiresAt: new Date("2026-08-16T12:00:00.000Z"), revocadoEn: null };
    expect(evaluarEstadoEnlace(enlace, AHORA)).toBe("EXPIRADO");
  });

  it("el instante exacto de caducidad ya NO es vigente", () => {
    const enlace = { expiresAt: AHORA, revocadoEn: null };
    expect(evaluarEstadoEnlace(enlace, AHORA)).toBe("EXPIRADO");
  });

  it("revocado, aunque todavía no hubiera caducado", () => {
    const enlace = {
      expiresAt: new Date("2026-08-30T12:00:00.000Z"),
      revocadoEn: new Date("2026-08-17T10:00:00.000Z"),
    };
    expect(evaluarEstadoEnlace(enlace, AHORA)).toBe("REVOCADO");
  });

  it("la revocación gana sobre la expiración", () => {
    // Si alguien lo revocó, eso es lo que hay que reportar aunque además
    // ya estuviera vencido.
    const enlace = {
      expiresAt: new Date("2026-08-01T12:00:00.000Z"),
      revocadoEn: new Date("2026-08-02T12:00:00.000Z"),
    };
    expect(evaluarEstadoEnlace(enlace, AHORA)).toBe("REVOCADO");
  });
});

describe("enlaceEsUtilizable", () => {
  it("solo un enlace vigente sirve", () => {
    expect(
      enlaceEsUtilizable(
        { expiresAt: new Date("2026-08-18T12:00:00.000Z"), revocadoEn: null },
        AHORA,
      ),
    ).toBe(true);

    expect(
      enlaceEsUtilizable(
        { expiresAt: new Date("2026-08-16T12:00:00.000Z"), revocadoEn: null },
        AHORA,
      ),
    ).toBe(false);

    expect(
      enlaceEsUtilizable(
        { expiresAt: new Date("2026-08-30T12:00:00.000Z"), revocadoEn: AHORA },
        AHORA,
      ),
    ).toBe(false);
  });
});

describe("normalizarVigenciaDias", () => {
  it("sin valor → default", () => {
    expect(normalizarVigenciaDias()).toBe(ENLACE_VIGENCIA_DIAS_DEFAULT);
  });

  it("valores inválidos caen al default en vez de fallar", () => {
    expect(normalizarVigenciaDias(0)).toBe(ENLACE_VIGENCIA_DIAS_DEFAULT);
    expect(normalizarVigenciaDias(-5)).toBe(ENLACE_VIGENCIA_DIAS_DEFAULT);
    expect(normalizarVigenciaDias(2.5)).toBe(ENLACE_VIGENCIA_DIAS_DEFAULT);
    expect(normalizarVigenciaDias(Number.NaN)).toBe(ENLACE_VIGENCIA_DIAS_DEFAULT);
  });

  it("respeta un valor válido dentro del rango", () => {
    expect(normalizarVigenciaDias(3)).toBe(3);
  });

  it("por encima del máximo se recorta, no se rechaza", () => {
    expect(normalizarVigenciaDias(365)).toBe(ENLACE_VIGENCIA_DIAS_MAX);
  });
});

describe("calcularExpiracion", () => {
  it("suma exactamente los días pedidos", () => {
    expect(calcularExpiracion(7, AHORA).toISOString()).toBe("2026-08-24T12:00:00.000Z");
  });

  it("un día es un día", () => {
    expect(calcularExpiracion(1, AHORA).toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });
});

describe("generarTokenEnlace", () => {
  it("produce tokens distintos en cada llamada", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generarTokenEnlace()));
    expect(tokens.size).toBe(50);
  });

  it("es suficientemente largo y seguro para URL", () => {
    const token = generarTokenEnlace();
    // 32 bytes en base64url → 43 caracteres, sin '+', '/' ni '='.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
