import { describe, expect, it } from "vitest";

import { existenteDeDetalles } from "./beneficiario-api";

// `existenteDeDetalles` lee `detalles` de los errores 409 `BENEFICIARIO_EXISTE`
// y `POSIBLE_BENEFICIARIO_DUPLICADO` (src/lib/cxp/errores.ts, P2, §B.7) tal
// como los serializa `cuerpoErrorCxp`. La UI del combo (CA-19, CA-41) depende
// de que esto lea el campo real: `existente` en uno, `existentes[]` en el otro.

describe("existenteDeDetalles (§B.7 BENEFICIARIO_EXISTE / POSIBLE_BENEFICIARIO_DUPLICADO)", () => {
  it("lee `existente` (BENEFICIARIO_EXISTE, CA-19)", () => {
    const r = existenteDeDetalles({
      existente: { id: "ben-1", nombre: 'ALMACENADORA DE CARGA "ALMACARGA" S.A.S', nit: "800154017-8" },
    });
    expect(r).toEqual({ id: "ben-1", nombre: 'ALMACENADORA DE CARGA "ALMACARGA" S.A.S', nit: "800154017-8" });
  });

  it("lee el primero de `existentes[]` (POSIBLE_BENEFICIARIO_DUPLICADO, CA-41)", () => {
    const r = existenteDeDetalles({
      existentes: [
        { id: "ben-2", nombre: "ALMACARGA SAS", nit: "800154017" },
        { id: "ben-3", nombre: "ALMACARGA OTRA", nit: "8001540178" },
      ],
    });
    expect(r).toEqual({ id: "ben-2", nombre: "ALMACARGA SAS", nit: "800154017" });
  });

  it("null cuando no hay coincidencias ni forma reconocida", () => {
    expect(existenteDeDetalles(undefined)).toBeNull();
    expect(existenteDeDetalles(null)).toBeNull();
    expect(existenteDeDetalles({})).toBeNull();
    expect(existenteDeDetalles({ existentes: [] })).toBeNull();
    expect(existenteDeDetalles("texto")).toBeNull();
  });

  it("nit null cuando la ficha no lo tiene", () => {
    const r = existenteDeDetalles({ existente: { id: "ben-4", nombre: "Persona sin NIT" } });
    expect(r).toEqual({ id: "ben-4", nombre: "Persona sin NIT", nit: null });
  });
});
