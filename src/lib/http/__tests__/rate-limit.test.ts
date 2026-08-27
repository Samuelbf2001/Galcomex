import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_MAX_INTENTOS,
  RATE_LIMIT_VENTANA_MS,
  construirClaveLimite,
  limpiarIntentos,
  registrarIntentoFallido,
  resetRateLimitParaTests,
  verificarLimite,
} from "../rate-limit";

describe("rate-limit (login)", () => {
  beforeEach(() => {
    resetRateLimitParaTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("construirClaveLimite normaliza el email (trim + minúsculas)", () => {
    expect(construirClaveLimite("1.2.3.4", "  Test@Example.com ")).toBe(
      "1.2.3.4:test@example.com",
    );
  });

  it("una clave sin intentos previos no está bloqueada", () => {
    const clave = construirClaveLimite("1.2.3.4", "nuevo@test.com");
    expect(verificarLimite(clave)).toEqual({ bloqueado: false });
  });

  it(`permite hasta ${RATE_LIMIT_MAX_INTENTOS - 1} intentos fallidos sin bloquear`, () => {
    const clave = construirClaveLimite("1.2.3.4", "user@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS - 1; i++) {
      registrarIntentoFallido(clave);
    }

    expect(verificarLimite(clave)).toEqual({ bloqueado: false });
  });

  it(`al llegar a ${RATE_LIMIT_MAX_INTENTOS} intentos fallidos bloquea la clave`, () => {
    const clave = construirClaveLimite("1.2.3.4", "user@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS; i++) {
      registrarIntentoFallido(clave);
    }

    const resultado = verificarLimite(clave);
    expect(resultado.bloqueado).toBe(true);
    if (resultado.bloqueado) {
      expect(resultado.segundosRestantes).toBeGreaterThan(0);
      expect(resultado.segundosRestantes).toBeLessThanOrEqual(
        RATE_LIMIT_VENTANA_MS / 1000,
      );
    }
  });

  it("un login exitoso (limpiarIntentos) resetea el contador", () => {
    const clave = construirClaveLimite("1.2.3.4", "user@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS; i++) {
      registrarIntentoFallido(clave);
    }
    expect(verificarLimite(clave)).toEqual({ bloqueado: true, segundosRestantes: expect.any(Number) });

    limpiarIntentos(clave);

    expect(verificarLimite(clave)).toEqual({ bloqueado: false });
  });

  it("tras expirar la ventana de 15 minutos, la clave se desbloquea", () => {
    const clave = construirClaveLimite("1.2.3.4", "user@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS; i++) {
      registrarIntentoFallido(clave);
    }
    expect(verificarLimite(clave).bloqueado).toBe(true);

    vi.advanceTimersByTime(RATE_LIMIT_VENTANA_MS + 1000);

    expect(verificarLimite(clave)).toEqual({ bloqueado: false });
  });

  it("un intento fallido tras expirar la ventana inicia un contador nuevo (no queda bloqueado de inmediato)", () => {
    const clave = construirClaveLimite("1.2.3.4", "user@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS; i++) {
      registrarIntentoFallido(clave);
    }
    vi.advanceTimersByTime(RATE_LIMIT_VENTANA_MS + 1000);

    registrarIntentoFallido(clave);

    expect(verificarLimite(clave)).toEqual({ bloqueado: false });
  });

  it("distintos emails desde la misma IP tienen contadores independientes", () => {
    const claveA = construirClaveLimite("1.2.3.4", "a@test.com");
    const claveB = construirClaveLimite("1.2.3.4", "b@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS; i++) {
      registrarIntentoFallido(claveA);
    }

    expect(verificarLimite(claveA).bloqueado).toBe(true);
    expect(verificarLimite(claveB)).toEqual({ bloqueado: false });
  });

  it("el mismo email desde distintas IPs tiene contadores independientes", () => {
    const claveIp1 = construirClaveLimite("1.1.1.1", "user@test.com");
    const claveIp2 = construirClaveLimite("2.2.2.2", "user@test.com");

    for (let i = 0; i < RATE_LIMIT_MAX_INTENTOS; i++) {
      registrarIntentoFallido(claveIp1);
    }

    expect(verificarLimite(claveIp1).bloqueado).toBe(true);
    expect(verificarLimite(claveIp2)).toEqual({ bloqueado: false });
  });
});
