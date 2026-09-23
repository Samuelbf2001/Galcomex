import { describe, expect, it } from "vitest";

import { visibilidadCabeceraDo } from "../cabecera-do";

describe("visibilidadCabeceraDo", () => {
  it("sin tipo de trámite (respuesta vieja) conserva el comportamiento histórico", () => {
    expect(visibilidadCabeceraDo(null)).toEqual({
      etiquetaReferenciaExterna: null,
      muestraCamposDo: true,
      muestraEta: true,
    });
    expect(visibilidadCabeceraDo(undefined)).toEqual({
      etiquetaReferenciaExterna: null,
      muestraCamposDo: true,
      muestraEta: true,
    });
  });

  it("IMPORTACION: sin referencia externa, con DO agencia/cliente y ETA", () => {
    expect(
      visibilidadCabeceraDo({
        etiquetaReferenciaExterna: null,
        usaCamposDo: true,
        requiereEta: true,
      }),
    ).toEqual({
      etiquetaReferenciaExterna: null,
      muestraCamposDo: true,
      muestraEta: true,
    });
  });

  it("CLASIFICACION: muestra el N° de informe de la clasificadora, oculta DO agencia/cliente y ETA", () => {
    expect(
      visibilidadCabeceraDo({
        etiquetaReferenciaExterna: "N° de informe de la clasificadora",
        usaCamposDo: false,
        requiereEta: false,
      }),
    ).toEqual({
      etiquetaReferenciaExterna: "N° de informe de la clasificadora",
      muestraCamposDo: false,
      muestraEta: false,
    });
  });

  it("OTRO: lleva etiqueta de referencia y conserva DO agencia/cliente (solo CLASIFICACION las oculta)", () => {
    expect(
      visibilidadCabeceraDo({
        etiquetaReferenciaExterna: "Servicio prestado",
        usaCamposDo: true,
        requiereEta: false,
      }),
    ).toEqual({
      etiquetaReferenciaExterna: "Servicio prestado",
      muestraCamposDo: true,
      muestraEta: false,
    });
  });
});
