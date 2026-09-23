/**
 * Requisitos del DO (D1 tarifa vigente, D2 BL + factura comercial) — lógica
 * pura, sin BD. Las capacidades se resuelven con el catálogo REAL del código,
 * así que estos tests también fijan los valores por defecto que decidió
 * Ernesto el 22-sep-2026.
 */

import { describe, expect, it } from "vitest";

import { CAPACIDADES } from "@/lib/capacidades/catalogo";
import { resolverCapacidades, type OverrideCapacidad } from "@/lib/capacidades/resolver";
import {
  abreSolicitud,
  armarRequisitos,
  documentosFaltantes,
  documentosRequeridos,
  entraAOperacion,
  exigeTarifaVigente,
  formatearFechaCorta,
  leerTiposTramite,
  mensajeDocumentosFaltantes,
  mensajeTarifaRequerida,
  nombreLineaServicio,
  tarifaFueraDeFecha,
  tiposTramiteDeRegla,
} from "@/lib/tramites/requisitos";

/** Mapa de capacidades de una empresa con estos overrides propios. */
function empresaCon(overrides: OverrideCapacidad[] = []) {
  return resolverCapacidades(CAPACIDADES, [], overrides);
}

const TARIFA_OFF: OverrideCapacidad = { codigo: "do_exige_tarifa_vigente", habilitado: false };
const DOCS_OFF: OverrideCapacidad = { codigo: "docs_bl_factura_obligatorios", habilitado: false };

describe("config tiposTramite", () => {
  it("lee una lista de códigos", () => {
    expect(leerTiposTramite({ tiposTramite: ["IMPORTACION", "OTRO"] })).toEqual([
      "IMPORTACION",
      "OTRO",
    ]);
    expect(leerTiposTramite({ tiposTramite: [] })).toEqual([]);
  });

  it("devuelve null si falta o está rota", () => {
    expect(leerTiposTramite(null)).toBeNull();
    expect(leerTiposTramite({})).toBeNull();
    expect(leerTiposTramite({ tiposTramite: "IMPORTACION" })).toBeNull();
    expect(leerTiposTramite({ tiposTramite: ["IMPORTACION", 3] })).toBeNull();
  });

  it("una config rota cae a la de fábrica del catálogo (la regla no se apaga sola)", () => {
    expect(tiposTramiteDeRegla("do_exige_tarifa_vigente", { tiposTramite: "x" })).toEqual([
      "IMPORTACION",
      "CLASIFICACION",
      "OTRO",
    ]);
    expect(tiposTramiteDeRegla("docs_bl_factura_obligatorios", null)).toEqual(["IMPORTACION"]);
    // Lista vacía = decisión explícita de no aplicarla a ningún tipo.
    expect(tiposTramiteDeRegla("docs_bl_factura_obligatorios", { tiposTramite: [] })).toEqual([]);
  });
});

describe("D1 · exigeTarifaVigente", () => {
  it("encendida por defecto para importación, clasificación y otros", () => {
    const capacidades = empresaCon();
    expect(exigeTarifaVigente(capacidades, "IMPORTACION")).toBe(true);
    expect(exigeTarifaVigente(capacidades, "CLASIFICACION")).toBe(true);
    expect(exigeTarifaVigente(capacidades, "OTRO")).toBe(true);
  });

  it("apagada en la empresa → nunca se exige", () => {
    const capacidades = empresaCon([TARIFA_OFF]);
    expect(exigeTarifaVigente(capacidades, "IMPORTACION")).toBe(false);
  });

  it("solo aplica a los tipos de la config de la empresa", () => {
    const capacidades = empresaCon([
      { codigo: "do_exige_tarifa_vigente", config: { tiposTramite: ["CLASIFICACION"] } },
    ]);
    expect(exigeTarifaVigente(capacidades, "IMPORTACION")).toBe(false);
    expect(exigeTarifaVigente(capacidades, "CLASIFICACION")).toBe(true);
  });

  it("la config del grupo económico también cuenta", () => {
    const capacidades = resolverCapacidades(
      CAPACIDADES,
      [{ codigo: "do_exige_tarifa_vigente", config: { tiposTramite: ["OTRO"] } }],
      [],
    );
    expect(exigeTarifaVigente(capacidades, "IMPORTACION")).toBe(false);
    expect(exigeTarifaVigente(capacidades, "OTRO")).toBe(true);
  });
});

describe("D2 · documentosRequeridos / documentosFaltantes", () => {
  it("por defecto solo la importación exige BL y factura comercial", () => {
    const capacidades = empresaCon();
    expect(documentosRequeridos(capacidades, "IMPORTACION")).toEqual(["BL", "FACTURA_COMERCIAL"]);
    expect(documentosRequeridos(capacidades, "CLASIFICACION")).toEqual([]);
    expect(documentosRequeridos(capacidades, "OTRO")).toEqual([]);
  });

  it("apagada → no se exige nada", () => {
    expect(documentosRequeridos(empresaCon([DOCS_OFF]), "IMPORTACION")).toEqual([]);
  });

  it("config por tipo de la empresa", () => {
    const capacidades = empresaCon([
      {
        codigo: "docs_bl_factura_obligatorios",
        habilitado: true,
        config: { tiposTramite: ["IMPORTACION", "OTRO"] },
      },
    ]);
    expect(documentosRequeridos(capacidades, "OTRO")).toEqual(["BL", "FACTURA_COMERCIAL"]);
  });

  it("calcula lo que falta contra las categorías presentes", () => {
    const requeridos = ["BL", "FACTURA_COMERCIAL"] as const;
    expect(documentosFaltantes(requeridos, [])).toEqual(["BL", "FACTURA_COMERCIAL"]);
    expect(documentosFaltantes(requeridos, ["BL", "PACKING_LIST"])).toEqual(["FACTURA_COMERCIAL"]);
    expect(documentosFaltantes(requeridos, ["FACTURA_COMERCIAL", "BL", "BL"])).toEqual([]);
    expect(documentosFaltantes([], ["BL"])).toEqual([]);
  });
});

describe("momentos del flujo", () => {
  it("abrir una solicitud: salir de SOLICITUD hacia cualquier estado menos CERRADO", () => {
    expect(abreSolicitud("SOLICITUD", "APERTURA")).toBe(true);
    expect(abreSolicitud("SOLICITUD", "EN_TRAMITE")).toBe(true);
    expect(abreSolicitud("SOLICITUD", "CERRADO")).toBe(false);
    expect(abreSolicitud("SOLICITUD", "SOLICITUD")).toBe(false);
    expect(abreSolicitud("APERTURA", "EN_TRAMITE")).toBe(false);
  });

  it("entrar a la operación: de SOLICITUD/APERTURA a EN_TRAMITE o más allá (sin CERRADO)", () => {
    expect(entraAOperacion("APERTURA", "EN_TRAMITE")).toBe(true);
    expect(entraAOperacion("APERTURA", "EN_PUERTO")).toBe(true);
    expect(entraAOperacion("SOLICITUD", "DESPACHADO")).toBe(true);
    expect(entraAOperacion("APERTURA", "CERRADO")).toBe(false);
    expect(entraAOperacion("SOLICITUD", "APERTURA")).toBe(false);
    expect(entraAOperacion("EN_TRAMITE", "EN_PUERTO")).toBe(false);
  });
});

describe("mensajes", () => {
  it("documentos: nombra lo que falta y el consecutivo, con tildes", () => {
    expect(mensajeDocumentosFaltantes(["BL", "FACTURA_COMERCIAL"], "DO.BAQ26-0301")).toBe(
      "Falta el BL y la factura comercial del DO.BAQ26-0301.",
    );
    expect(mensajeDocumentosFaltantes(["BL"], "DO.BAQ26-0301")).toBe("Falta el BL del DO.BAQ26-0301.");
    expect(mensajeDocumentosFaltantes(["FACTURA_COMERCIAL"], "OTR26-0002")).toBe(
      "Falta la factura comercial del trámite OTR26-0002.",
    );
  });

  it("tarifa al crear (texto acordado con Ernesto)", () => {
    expect(
      mensajeTarifaRequerida({
        empresa: "LITOPLAS SA",
        lineaServicio: "TRAMITE",
        tarifarioPropioActivo: true,
      }),
    ).toBe(
      "LITOPLAS SA no tiene una tarifa vigente de importación. Publica la tarifa de la empresa antes de crear el DO.",
    );
  });

  it("tarifa al abrir una solicitud: nombra el DO", () => {
    expect(
      mensajeTarifaRequerida({
        empresa: "POLYREC SAS",
        lineaServicio: "CLASIFICACION",
        tarifarioPropioActivo: true,
        consecutivo: "CLAS26-0004",
      }),
    ).toBe(
      "POLYREC SAS no tiene una tarifa vigente de clasificación arancelaria. Publica la tarifa de la empresa antes de abrir el trámite CLAS26-0004.",
    );
  });

  it("tarifa sin tarifario propio: pide activar la función primero", () => {
    expect(
      mensajeTarifaRequerida({
        empresa: "SESDERMA",
        lineaServicio: "OTROS",
        tarifarioPropioActivo: false,
        consecutivo: "DO.BAQ26-0301",
      }),
    ).toBe(
      "SESDERMA no tiene una tarifa vigente de otros servicios. Activa «Tarifario propio versionado» en la pestaña Funciones de la empresa y publica su tarifa antes de abrir el DO.BAQ26-0301.",
    );
  });

  it("tarifa publicada pero vencida o futura: dice la fecha", () => {
    expect(
      mensajeTarifaRequerida({
        empresa: "CW ASIA",
        lineaServicio: "TRAMITE",
        tarifarioPropioActivo: true,
        fueraDeFecha: { motivo: "VENCIDA", fecha: new Date("2027-01-31T00:00:00.000Z") },
      }),
    ).toBe(
      "CW ASIA no tiene una tarifa vigente de importación: la publicada venció el 31/01/2027. Publica la tarifa de la empresa antes de crear el DO.",
    );
    expect(
      mensajeTarifaRequerida({
        empresa: "CW ASIA",
        lineaServicio: "TRAMITE",
        tarifarioPropioActivo: true,
        fueraDeFecha: { motivo: "FUTURA", fecha: new Date("2027-02-01T00:00:00.000Z") },
      }),
    ).toContain(": la publicada empieza a regir el 01/02/2027.");
  });

  it("líneas de servicio legibles, también las que no conoce", () => {
    expect(nombreLineaServicio("TRAMITE")).toBe("importación");
    expect(nombreLineaServicio("PLAN_VALLEJO")).toBe("Plan Vallejo");
    expect(nombreLineaServicio("TRANSPORTE_TERRESTRE")).toBe("transporte terrestre");
  });

  it("fecha corta en UTC", () => {
    expect(formatearFechaCorta(new Date("2026-02-02T00:00:00.000Z"))).toBe("02/02/2026");
  });
});

describe("tarifaFueraDeFecha", () => {
  const publicada = {
    vigenteDesde: new Date("2026-02-02T00:00:00.000Z"),
    vigenteHasta: new Date("2027-01-31T00:00:00.000Z"),
  };

  it("en fecha (incluido el último día completo) → null", () => {
    expect(tarifaFueraDeFecha(publicada, new Date("2026-09-22T15:00:00.000Z"))).toBeNull();
    expect(tarifaFueraDeFecha(publicada, new Date("2027-01-31T23:59:59.000Z"))).toBeNull();
  });

  it("vencida o futura", () => {
    expect(tarifaFueraDeFecha(publicada, new Date("2027-02-01T00:00:00.000Z"))).toEqual({
      motivo: "VENCIDA",
      fecha: publicada.vigenteHasta,
    });
    expect(tarifaFueraDeFecha(publicada, new Date("2026-01-15T00:00:00.000Z"))).toEqual({
      motivo: "FUTURA",
      fecha: publicada.vigenteDesde,
    });
  });

  it("sin tarifa publicada → null", () => {
    expect(tarifaFueraDeFecha(null, new Date())).toBeNull();
  });
});

describe("armarRequisitos (contrato de GET /api/tramites/requisitos)", () => {
  const importacion = { codigo: "IMPORTACION", lineaServicio: "TRAMITE" };
  const tarifario = {
    id: "t1",
    nombre: "Tarifas 2026 importaciones",
    version: 3,
    vigenteHasta: new Date("2027-01-31T00:00:00.000Z"),
  };

  it("exigida y sin tarifa → no cumple, con el mismo mensaje del servidor", () => {
    const requisitos = armarRequisitos({
      capacidades: empresaCon([{ codigo: "tarifario_propio", habilitado: true }]),
      empresa: "LITOPLAS SA",
      tipoTramite: importacion,
      tarifario: null,
      fueraDeFecha: null,
    });

    expect(requisitos).toEqual({
      tarifaVigente: {
        requerida: true,
        cumple: false,
        lineaServicio: "TRAMITE",
        tarifario: null,
        tarifarioPropioHabilitado: true,
        mensaje:
          "LITOPLAS SA no tiene una tarifa vigente de importación. Publica la tarifa de la empresa antes de crear el DO.",
      },
      documentosObligatorios: { requeridos: ["BL", "FACTURA_COMERCIAL"] },
    });
  });

  it("con tarifa vigente → cumple y la devuelve", () => {
    const requisitos = armarRequisitos({
      capacidades: empresaCon([{ codigo: "tarifario_propio", habilitado: true }]),
      empresa: "LITOPLAS SA",
      tipoTramite: importacion,
      tarifario,
      fueraDeFecha: null,
    });

    expect(requisitos.tarifaVigente).toMatchObject({ requerida: true, cumple: true, tarifario, mensaje: null });
  });

  it("empresa con las dos reglas apagadas (caso socio) → nada exigido", () => {
    const requisitos = armarRequisitos({
      capacidades: empresaCon([TARIFA_OFF, DOCS_OFF]),
      empresa: "COMALI",
      tipoTramite: importacion,
      tarifario: null,
      fueraDeFecha: null,
    });

    expect(requisitos.tarifaVigente).toMatchObject({
      requerida: false,
      cumple: true,
      tarifarioPropioHabilitado: false,
      mensaje: null,
    });
    expect(requisitos.documentosObligatorios.requeridos).toEqual([]);
  });
});
