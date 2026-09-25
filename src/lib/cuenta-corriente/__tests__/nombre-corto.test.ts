import { describe, expect, it } from "vitest";

import { nombreCortoEmpresa } from "@/lib/cuenta-corriente/nombre-corto";

describe("nombreCortoEmpresa", () => {
  it("quita el prefijo de agencia y los sufijos societarios y de nivel", () => {
    expect(nombreCortoEmpresa("AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS")).toBe("COLDEX");
  });

  it("quita el prefijo de almacenadora y las comillas", () => {
    expect(nombreCortoEmpresa('ALMACENADORA DE CARGA "ALMACARGA" S.A.S')).toBe("ALMACARGA");
  });

  it("deja igual un nombre que no tiene nada que quitar", () => {
    expect(nombreCortoEmpresa("ASCINTER")).toBe("ASCINTER");
  });

  it("quita SAS sin puntos y LTDA", () => {
    expect(nombreCortoEmpresa("ELTRANS SAS")).toBe("ELTRANS");
    expect(nombreCortoEmpresa("TRANSPORTES RAPIDOS LTDA")).toBe("TRANSPORTES RAPIDOS");
  });

  it("quita paréntesis", () => {
    expect(nombreCortoEmpresa("GRUPO E PAPIS (COLOMBIA) S.A.")).toBe("GRUPO E PAPIS COLOMBIA");
  });

  it("si al quitar todo no queda nada, devuelve el nombre original", () => {
    expect(nombreCortoEmpresa("S.A.S")).toBe("S.A.S");
  });
});
