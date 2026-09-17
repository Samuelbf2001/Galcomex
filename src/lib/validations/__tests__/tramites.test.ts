import { describe, expect, it } from "vitest";

import { tramiteUpdateSchema } from "../tramites";

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
