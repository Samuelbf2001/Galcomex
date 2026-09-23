import { describe, expect, it } from "vitest";

import { tramiteQuerySchema, tramiteUpdateSchema } from "../tramites";

describe("tramiteUpdateSchema — fechas en PATCH parcial", () => {
  it("no borra la ETA ni las fechas clave cuando no vienen en el payload", () => {
    const payload = tramiteUpdateSchema.parse({ numDeclaraciones: 1, numDocumentos: 2 });

    expect(payload.eta).toBeUndefined();
    expect(payload.fechaLevante).toBeUndefined();
    expect(payload.fechaAceptacionDeclaracion).toBeUndefined();
    expect(payload.fechaEnviadoAFacturar).toBeUndefined();
    expect(payload.fechaDocumentosOk).toBeUndefined();
    expect(payload.fechaSalidaCarga).toBeUndefined();
  });

  it("borra la fecha cuando se envía null explícito", () => {
    expect(tramiteUpdateSchema.parse({ eta: null }).eta).toBeNull();
  });

  it("convierte la fecha ISO enviada", () => {
    expect(tramiteUpdateSchema.parse({ eta: "2026-03-09T00:00:00Z" }).eta).toEqual(
      new Date("2026-03-09T00:00:00Z"),
    );
  });
});

describe("tramiteQuerySchema — orden (A8)", () => {
  it("ordenarPor y direccion son opcionales: sin ellos no hay error", () => {
    const query = tramiteQuerySchema.parse({});
    expect(query.ordenarPor).toBeUndefined();
    expect(query.direccion).toBeUndefined();
  });

  it("acepta cada columna ordenable con asc y desc", () => {
    const columnas = [
      "consecutivo",
      "cliente",
      "estado",
      "ciudad",
      "modalidad",
      "apertura",
      "movimiento",
      "responsable",
    ] as const;

    for (const ordenarPor of columnas) {
      for (const direccion of ["asc", "desc"] as const) {
        expect(tramiteQuerySchema.parse({ ordenarPor, direccion })).toMatchObject({
          ordenarPor,
          direccion,
        });
      }
    }
  });

  it("rechaza una columna que no es ordenable (Referencia y Docs no lo son)", () => {
    expect(() => tramiteQuerySchema.parse({ ordenarPor: "referencia" })).toThrow();
    expect(() => tramiteQuerySchema.parse({ ordenarPor: "docs" })).toThrow();
  });

  it("rechaza una direccion que no sea asc/desc", () => {
    expect(() => tramiteQuerySchema.parse({ ordenarPor: "cliente", direccion: "ASC" })).toThrow();
  });
});
