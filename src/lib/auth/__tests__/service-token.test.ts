import { describe, expect, it } from "vitest";

import { tieneTokenDeServicioValido } from "../service-token";

const SECRETO = "un-secreto-largo-de-verdad-para-pruebas";

describe("tieneTokenDeServicioValido", () => {
  it("acepta el secreto correcto con el esquema Bearer", () => {
    expect(tieneTokenDeServicioValido(`Bearer ${SECRETO}`, SECRETO)).toBe(true);
  });

  it("rechaza un secreto incorrecto", () => {
    expect(tieneTokenDeServicioValido("Bearer otro-secreto", SECRETO)).toBe(false);
  });

  it("rechaza sin cabecera Authorization", () => {
    expect(tieneTokenDeServicioValido(null, SECRETO)).toBe(false);
  });

  it("rechaza sin el esquema Bearer", () => {
    expect(tieneTokenDeServicioValido(SECRETO, SECRETO)).toBe(false);
  });

  it("rechaza si el secreto esperado no está configurado", () => {
    expect(tieneTokenDeServicioValido(`Bearer ${SECRETO}`, undefined)).toBe(false);
  });

  it("rechaza secretos de largo distinto sin lanzar", () => {
    expect(() => tieneTokenDeServicioValido("Bearer x", SECRETO)).not.toThrow();
    expect(tieneTokenDeServicioValido("Bearer x", SECRETO)).toBe(false);
  });

  it("rechaza un prefijo Bearer sin espacio (case exacto)", () => {
    expect(tieneTokenDeServicioValido(`bearer ${SECRETO}`, SECRETO)).toBe(false);
  });
});
