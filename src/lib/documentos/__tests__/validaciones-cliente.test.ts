/**
 * Test unitario puro (sin BD) del esquema Zod de query params de
 * GET /api/clientes/[id]/documentos.
 */
import { CategoriaDocumento } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { documentosClienteQuerySchema } from "../validaciones-cliente";

describe("documentosClienteQuerySchema", () => {
  it("aplica defaults take=50 y skip=0 cuando no se pasan", () => {
    const parsed = documentosClienteQuerySchema.parse({});
    expect(parsed.take).toBe(50);
    expect(parsed.skip).toBe(0);
    expect(parsed.categoria).toBeUndefined();
    expect(parsed.desde).toBeUndefined();
    expect(parsed.hasta).toBeUndefined();
  });

  it("acepta una categoria válida del enum", () => {
    const parsed = documentosClienteQuerySchema.parse({ categoria: CategoriaDocumento.BL });
    expect(parsed.categoria).toBe("BL");
  });

  it("rechaza una categoria inválida", () => {
    expect(() => documentosClienteQuerySchema.parse({ categoria: "NO_EXISTE" })).toThrow(ZodError);
  });

  it("take respeta el máximo de 100", () => {
    expect(() => documentosClienteQuerySchema.parse({ take: "101" })).toThrow(ZodError);
    const parsed = documentosClienteQuerySchema.parse({ take: "100" });
    expect(parsed.take).toBe(100);
  });

  it("take respeta el mínimo de 1", () => {
    expect(() => documentosClienteQuerySchema.parse({ take: "0" })).toThrow(ZodError);
  });

  it("skip rechaza negativos", () => {
    expect(() => documentosClienteQuerySchema.parse({ skip: "-1" })).toThrow(ZodError);
  });

  it("transforma desde/hasta (fecha simple, ej. de <input type=date>) a Date", () => {
    const parsed = documentosClienteQuerySchema.parse({ desde: "2026-01-01", hasta: "2026-12-31" });
    expect(parsed.desde).toBeInstanceOf(Date);
    expect(parsed.hasta).toBeInstanceOf(Date);
  });

  it("acepta datetime ISO completo", () => {
    const parsed = documentosClienteQuerySchema.parse({ desde: "2026-01-01T10:00:00.000Z" });
    expect(parsed.desde).toBeInstanceOf(Date);
  });

  it("rechaza una fecha con formato inválido", () => {
    expect(() => documentosClienteQuerySchema.parse({ desde: "no-es-una-fecha" })).toThrow(ZodError);
  });

  it("rechaza cuando desde > hasta", () => {
    expect(() =>
      documentosClienteQuerySchema.parse({ desde: "2026-06-01", hasta: "2026-01-01" }),
    ).toThrow(ZodError);
  });

  it("acepta desde === hasta", () => {
    const parsed = documentosClienteQuerySchema.parse({ desde: "2026-01-01", hasta: "2026-01-01" });
    expect(parsed.desde?.getTime()).toBe(parsed.hasta?.getTime());
  });
});
