import { describe, expect, it } from "vitest";

import { destinoInternoSeguro } from "../rutas-roles";

describe("destinoInternoSeguro", () => {
  it("rechaza tab embebido (equivalente a ?next=/%09/evil.com ya decodificado): el navegador lo borra y queda //evil.com", () => {
    expect(destinoInternoSeguro("/\t/evil.com")).toBeNull();
  });

  it("rechaza salto de línea y retorno de carro embebidos por la misma razón", () => {
    expect(destinoInternoSeguro("/\n/evil.com")).toBeNull();
    expect(destinoInternoSeguro("/\r/evil.com")).toBeNull();
  });

  it("rechaza backslash: el navegador lo normaliza a / y cambia de host", () => {
    expect(destinoInternoSeguro("/\\evil.com")).toBeNull();
  });

  it("rechaza // al inicio (protocol-relative URL)", () => {
    expect(destinoInternoSeguro("//evil.com")).toBeNull();
  });

  it("rechaza URL absoluta con esquema y host", () => {
    expect(destinoInternoSeguro("https://evil.com")).toBeNull();
  });

  it("rechaza rutas que no empiezan por /", () => {
    expect(destinoInternoSeguro("evil.com")).toBeNull();
  });

  it("rechaza vuelta a /auth/ y a /api/", () => {
    expect(destinoInternoSeguro("/auth/login")).toBeNull();
    expect(destinoInternoSeguro("/api/login")).toBeNull();
  });

  it("acepta una ruta interna válida con query string", () => {
    expect(destinoInternoSeguro("/tramites?x=1")).toBe("/tramites?x=1");
  });

  it("acepta una ruta interna simple", () => {
    expect(destinoInternoSeguro("/dashboard")).toBe("/dashboard");
  });

  it("null/undefined/vacío devuelven null", () => {
    expect(destinoInternoSeguro(null)).toBeNull();
    expect(destinoInternoSeguro(undefined)).toBeNull();
    expect(destinoInternoSeguro("")).toBeNull();
  });
});
