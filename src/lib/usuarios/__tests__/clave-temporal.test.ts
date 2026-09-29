// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PASSWORD_MIN } from "@/lib/auth/estado-cuenta";
import { ALFABETO_CLAVE_TEMPORAL, generarClaveTemporal } from "@/lib/usuarios/clave-temporal";

describe("generarClaveTemporal", () => {
  it("tiene 14 caracteres en tres grupos de 4 y cumple el mínimo de la política", () => {
    const clave = generarClaveTemporal();
    expect(clave).toMatch(/^[^-]{4}-[^-]{4}-[^-]{4}$/);
    expect(clave).toHaveLength(14);
    expect(clave.length).toBeGreaterThanOrEqual(PASSWORD_MIN);
  });

  it("solo usa el alfabeto sin caracteres ambiguos (0/O/o, 1/l/I/i)", () => {
    for (const ambiguo of ["0", "O", "o", "1", "l", "I", "i"]) {
      expect(ALFABETO_CLAVE_TEMPORAL).not.toContain(ambiguo);
    }
    for (let n = 0; n < 200; n++) {
      for (const c of generarClaveTemporal().replaceAll("-", "")) {
        expect(ALFABETO_CLAVE_TEMPORAL).toContain(c);
      }
    }
  });

  it("no repite claves (aleatoriedad de crypto)", () => {
    const claves = new Set(Array.from({ length: 500 }, () => generarClaveTemporal()));
    expect(claves.size).toBe(500);
  });
});
