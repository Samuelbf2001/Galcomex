import { describe, expect, it } from "vitest";

import {
  PREFIJO_CUADRE_HISTORICO,
  cuadrePendiente,
  esCuadreHistorico,
  esItemCuadreHistorico,
  permisoItemChecklist,
  puedeCerrarCuadre,
  tieneCuadreHistorico,
} from "../cuadre-historico";

// Texto exacto que dejó la carga (lote HIST-PLATA-2026-09-23), con la "Ó" en NFC.
const CUADRE_ROJO = "CUADRE DE PLATA HISTÓRICA · ROJO";
const CUADRE_AMARILLO = "CUADRE DE PLATA HISTÓRICA · AMARILLO";
const CUADRE_VERDE = "CUADRE DE PLATA HISTÓRICA · VERDE";

describe("esItemCuadreHistorico", () => {
  it("reconoce los tres colores de la marca", () => {
    expect(esItemCuadreHistorico(CUADRE_ROJO)).toBe(true);
    expect(esItemCuadreHistorico(CUADRE_AMARILLO)).toBe(true);
    expect(esItemCuadreHistorico(CUADRE_VERDE)).toBe(true);
  });

  it("el prefijo está en NFC y acepta la «Ó» en NFD (normaliza)", () => {
    expect(PREFIJO_CUADRE_HISTORICO).toBe(PREFIJO_CUADRE_HISTORICO.normalize("NFC"));
    const nfd = "CUADRE DE PLATA HISTÓRICA · ROJO".normalize("NFD");
    expect(nfd).not.toBe(CUADRE_ROJO);
    expect(esItemCuadreHistorico(nfd)).toBe(true);
  });

  it("no confunde otros textos", () => {
    expect(esItemCuadreHistorico("cuadre de plata histórica · ROJO")).toBe(false);
    expect(esItemCuadreHistorico("CUADRE DE PLATA")).toBe(false);
    expect(esItemCuadreHistorico("Factura comercial")).toBe(false);
    expect(esItemCuadreHistorico("")).toBe(false);
  });
});

describe("esCuadreHistorico: exige trámite histórico", () => {
  it("mismo texto en un DO no histórico es un ítem normal", () => {
    expect(esCuadreHistorico({ esHistorico: true }, { descripcion: CUADRE_ROJO })).toBe(true);
    expect(esCuadreHistorico({ esHistorico: false }, { descripcion: CUADRE_ROJO })).toBe(false);
    expect(esCuadreHistorico({ esHistorico: null }, { descripcion: CUADRE_ROJO })).toBe(false);
    expect(esCuadreHistorico({}, { descripcion: CUADRE_ROJO })).toBe(false);
  });
});

describe("permisoItemChecklist (matriz rol × estado × histórico × cuadre)", () => {
  const roles = ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const;
  const estados = ["EN_TRAMITE", "FACTURADO", "PAGADO", "CERRADO"] as const;

  for (const rol of roles) {
    for (const estadoTramite of estados) {
      for (const esHistorico of [true, false]) {
        for (const descripcion of [CUADRE_AMARILLO, "Factura comercial"]) {
          const cuadre = esHistorico && descripcion === CUADRE_AMARILLO;
          const nombre = `${rol} · ${estadoTramite} · ${esHistorico ? "histórico" : "normal"} · ${cuadre ? "cuadre" : "ítem normal"}`;
          it(nombre, () => {
            const r = permisoItemChecklist({ rol, estadoTramite, esHistorico, descripcion });
            if (estadoTramite === "CERRADO") {
              expect(r).toEqual({ ok: false, motivo: "CERRADO" });
            } else if (cuadre && (rol === "OPERATIVO" || rol === "SOCIO")) {
              expect(r).toEqual({ ok: false, motivo: "ROL_CUADRE" });
            } else {
              expect(r).toEqual({ ok: true, cuadre });
            }
          });
        }
      }
    }
  }
});

describe("puedeCerrarCuadre", () => {
  it("ADMIN y REVISOR en cualquier estado salvo CERRADO", () => {
    for (const estado of ["SOLICITUD", "APERTURA", "EN_TRAMITE", "FACTURADO", "PAGADO"]) {
      expect(puedeCerrarCuadre("ADMIN", estado)).toBe(true);
      expect(puedeCerrarCuadre("REVISOR", estado)).toBe(true);
    }
    expect(puedeCerrarCuadre("ADMIN", "CERRADO")).toBe(false);
    expect(puedeCerrarCuadre("REVISOR", "CERRADO")).toBe(false);
  });

  it("OPERATIVO, SOCIO o sin rol nunca", () => {
    expect(puedeCerrarCuadre("OPERATIVO", "FACTURADO")).toBe(false);
    expect(puedeCerrarCuadre("SOCIO", "FACTURADO")).toBe(false);
    expect(puedeCerrarCuadre(null, "FACTURADO")).toBe(false);
    expect(puedeCerrarCuadre(undefined, "FACTURADO")).toBe(false);
  });
});

describe("tieneCuadreHistorico y cuadrePendiente", () => {
  const item = (descripcion: string, recibido: boolean, requerido = true) => ({ descripcion, recibido, requerido });

  it("histórico con el ítem sin marcar: tiene y está pendiente", () => {
    const t = { esHistorico: true, checklistItems: [item("BL", true), item(CUADRE_ROJO, false)] };
    expect(tieneCuadreHistorico(t)).toBe(true);
    expect(cuadrePendiente(t)).toBe(true);
  });

  it("histórico con el ítem cerrado: tiene, ya no pendiente", () => {
    const t = { esHistorico: true, checklistItems: [item(CUADRE_VERDE, true)] };
    expect(tieneCuadreHistorico(t)).toBe(true);
    expect(cuadrePendiente(t)).toBe(false);
  });

  it("un ítem de cuadre no requerido no cuenta como pendiente", () => {
    expect(cuadrePendiente({ esHistorico: true, checklistItems: [item(CUADRE_ROJO, false, false)] })).toBe(false);
  });

  it("histórico sin plata (sin ítem) o DO normal: ni tiene ni pendiente", () => {
    expect(tieneCuadreHistorico({ esHistorico: true, checklistItems: [item("BL", false)] })).toBe(false);
    expect(cuadrePendiente({ esHistorico: true, checklistItems: [item("BL", false)] })).toBe(false);
    expect(tieneCuadreHistorico({ esHistorico: false, checklistItems: [item(CUADRE_ROJO, false)] })).toBe(false);
    expect(cuadrePendiente({ esHistorico: false, checklistItems: [item(CUADRE_ROJO, false)] })).toBe(false);
    expect(cuadrePendiente({ esHistorico: true })).toBe(false);
  });
});
