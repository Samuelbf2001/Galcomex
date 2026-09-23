import { describe, expect, it } from "vitest";

import { CAMPOS_ORDEN_TRAMITE, construirOrdenTramites } from "../orden";

describe("construirOrdenTramites", () => {
  it("sin ordenarPor mantiene el orden de siempre (kanban incluido)", () => {
    expect(construirOrdenTramites()).toEqual([
      { anio: "desc" },
      { ciudad: "asc" },
      { numero: "desc" },
      { id: "asc" },
    ]);
  });

  it("consecutivo aplica la misma dirección a anio, ciudad y numero", () => {
    expect(construirOrdenTramites("consecutivo", "asc")).toEqual([
      { anio: "asc" },
      { ciudad: "asc" },
      { numero: "asc" },
      { id: "asc" },
    ]);
    expect(construirOrdenTramites("consecutivo", "desc")).toEqual([
      { anio: "desc" },
      { ciudad: "desc" },
      { numero: "desc" },
      { id: "asc" },
    ]);
  });

  it("cliente ordena por el nombre de la relación", () => {
    expect(construirOrdenTramites("cliente", "asc")).toEqual([
      { cliente: { nombre: "asc" } },
      { id: "asc" },
    ]);
  });

  it("estado ordena por el enum (Postgres respeta el orden de declaración = pipeline)", () => {
    expect(construirOrdenTramites("estado", "asc")).toEqual([
      { estado: "asc" },
      { id: "asc" },
    ]);
  });

  it("ciudad y modalidad ordenan por su columna directa", () => {
    expect(construirOrdenTramites("ciudad", "desc")).toEqual([
      { ciudad: "desc" },
      { id: "asc" },
    ]);
    expect(construirOrdenTramites("modalidad", "asc")).toEqual([
      { agenciaAduanas: "asc" },
      { id: "asc" },
    ]);
  });

  it("apertura y movimiento ordenan por createdAt/updatedAt", () => {
    expect(construirOrdenTramites("apertura", "desc")).toEqual([
      { createdAt: "desc" },
      { id: "asc" },
    ]);
    expect(construirOrdenTramites("movimiento", "desc")).toEqual([
      { updatedAt: "desc" },
      { id: "asc" },
    ]);
  });

  it("responsable ordena por el nombre de quien creó el DO", () => {
    expect(construirOrdenTramites("responsable", "asc")).toEqual([
      { creadoPor: { name: "asc" } },
      { id: "asc" },
    ]);
  });

  it("siempre agrega id como desempate estable, sin importar el campo", () => {
    for (const campo of CAMPOS_ORDEN_TRAMITE) {
      const orden = construirOrdenTramites(campo, "asc");
      expect(orden[orden.length - 1]).toEqual({ id: "asc" });
    }
  });

  it("CAMPOS_ORDEN_TRAMITE no incluye Referencia ni Docs (no son ordenables)", () => {
    expect(CAMPOS_ORDEN_TRAMITE).not.toContain("referencia");
    expect(CAMPOS_ORDEN_TRAMITE).not.toContain("docs");
  });
});
