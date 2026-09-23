/**
 * Tests de `resolverIp` — POST /api/login
 *
 * El límite de intentos se indexa por IP+email (`construirClaveLimite`).
 * Antes se tomaba el PRIMER valor de `X-Forwarded-For`, que el cliente
 * controla libremente: un atacante podía rotar ese valor en cada request y
 * saltarse el bloqueo aunque Traefik metiera siempre la misma IP real al
 * final de la cabecera. Ahora se toma el ÚLTIMO valor no vacío (el que
 * agrega el proxy de confianza).
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { resolverIp } from "../route";

function peticion(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/login", { headers });
}

describe("resolverIp", () => {
  it("con una sola IP en X-Forwarded-For, la usa", () => {
    expect(resolverIp(peticion({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("con varias IPs, toma la ÚLTIMA (la que añade el proxy de confianza), no la primera falsificable", () => {
    const request = peticion({
      "x-forwarded-for": "1.2.3.4, 10.0.0.9, 203.0.113.5",
    });
    expect(resolverIp(request)).toBe("203.0.113.5");
  });

  it("ignora espacios alrededor de cada valor y valores vacíos al final", () => {
    expect(resolverIp(peticion({ "x-forwarded-for": "1.2.3.4 ,  203.0.113.5 , " }))).toBe(
      "203.0.113.5",
    );
  });

  it("un atacante que rota el primer valor no cambia la IP resuelta si el proxy sigue añadiendo la misma al final", () => {
    const claveA = resolverIp(peticion({ "x-forwarded-for": "1.1.1.1, 203.0.113.5" }));
    const claveB = resolverIp(peticion({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" }));
    expect(claveA).toBe("203.0.113.5");
    expect(claveB).toBe("203.0.113.5");
  });

  it("sin X-Forwarded-For, usa x-real-ip", () => {
    expect(resolverIp(peticion({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("sin ninguna cabecera, devuelve 'desconocida'", () => {
    expect(resolverIp(peticion())).toBe("desconocida");
  });
});
