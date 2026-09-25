import { describe, expect, it } from "vitest";

import { tramiteCreateSchema, tramiteQuerySchema, tramiteUpdateSchema } from "../tramites";

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

// D0 (histórico 2026): Bogotá. La migración 20260921120000_ciudad_bgt ya está en
// producción; con BGT en el esquema, Zod (z.nativeEnum(Ciudad)) deja crear y
// filtrar DOs de Bogotá (antes: 400 "Payload invalido").
describe("Ciudad BGT (Bogotá)", () => {
  it("es válida para crear un DO", () => {
    const payload = tramiteCreateSchema.parse({ ciudad: "BGT", clienteId: "cliente-1" });
    expect(payload.ciudad).toBe("BGT");
  });

  it("es válida para filtrar el listado", () => {
    expect(tramiteQuerySchema.parse({ ciudad: "BGT" }).ciudad).toBe("BGT");
  });

  it("una ciudad que no existe sigue rechazándose", () => {
    expect(() => tramiteCreateSchema.parse({ ciudad: "MDE", clienteId: "cliente-1" })).toThrow();
  });
});
