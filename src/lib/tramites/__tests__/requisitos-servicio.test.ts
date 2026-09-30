/**
 * Requisitos por servicio (DISENO-NUMERACION.md §2.2.5, caso 12 del §8;
 * decisión de Ernesto 30-sep-2026): la nacionalización no tiene BL. Puro.
 */
import { describe, expect, it } from "vitest";

import { CAPACIDADES } from "@/lib/capacidades/catalogo";
import { resolverCapacidades, type OverrideCapacidad } from "@/lib/capacidades/resolver";
import { armarRequisitos, documentosRequeridos, mensajeTarifaRequerida } from "@/lib/tramites/requisitos";

function empresaCon(overrides: OverrideCapacidad[] = []) {
  return resolverCapacidades(CAPACIDADES, [], overrides);
}

const DOCS_OFF: OverrideCapacidad = { codigo: "docs_bl_factura_obligatorios", habilitado: false };

describe("caso 12 — documentosRequeridos con el servicio", () => {
  it("Nacionalización → solo la factura comercial", () => {
    expect(documentosRequeridos(empresaCon(), "IMPORTACION", ["BL"])).toEqual(["FACTURA_COMERCIAL"]);
  });

  it("DUTA, traslado e importación general → BL y factura comercial", () => {
    expect(documentosRequeridos(empresaCon(), "IMPORTACION", [])).toEqual(["BL", "FACTURA_COMERCIAL"]);
    expect(documentosRequeridos(empresaCon(), "IMPORTACION")).toEqual(["BL", "FACTURA_COMERCIAL"]);
  });

  it("empresa con D2 apagada → nada, con cualquier servicio (el servicio nunca agrega documentos)", () => {
    expect(documentosRequeridos(empresaCon([DOCS_OFF]), "IMPORTACION", ["BL"])).toEqual([]);
    expect(documentosRequeridos(empresaCon([DOCS_OFF]), "IMPORTACION", [])).toEqual([]);
  });
});

describe("mensaje de D1 con el servicio", () => {
  it("un servicio con tarifa propia se nombra y ofrece escoger otro", () => {
    expect(
      mensajeTarifaRequerida({
        empresa: "POLYREC ZONA FRANCA S.A.S",
        lineaServicio: "TRAMITE",
        tarifarioPropioActivo: true,
        servicioNombre: "DUTA (tránsito aduanero)",
      }),
    ).toBe(
      "POLYREC ZONA FRANCA S.A.S no tiene una tarifa vigente de importación para el servicio «DUTA (tránsito aduanero)». Publica la tarifa de ese servicio o escoge otro servicio.",
    );
  });

  it("sin servicio (importación general) el mensaje es el de siempre", () => {
    expect(
      mensajeTarifaRequerida({ empresa: "LITOPLAS SA", lineaServicio: "TRAMITE", tarifarioPropioActivo: true }),
    ).toBe("LITOPLAS SA no tiene una tarifa vigente de importación. Publica la tarifa de la empresa antes de crear el DO.");
  });
});

describe("armarRequisitos con servicio y número", () => {
  it("nacionalización: no pide BL, nombra el servicio y trae la vista previa del número", () => {
    const requisitos = armarRequisitos({
      capacidades: empresaCon([{ codigo: "tarifario_propio", habilitado: true }]),
      empresa: "POLYREC ZONA FRANCA S.A.S",
      tipoTramite: { codigo: "IMPORTACION", lineaServicio: "TRAMITE" },
      tarifario: null,
      fueraDeFecha: null,
      servicio: {
        codigo: "NACIONALIZACION_ZF",
        nombre: "Nacionalización desde zona franca",
        claveTarifa: "NACIONALIZACION_ZF",
        documentosNoAplican: ["BL"],
      },
      numeracion: { siguiente: "DO.BGT26-0282", contador: "contador compartido Barranquilla, Bogotá y Buenaventura" },
    });
    expect(requisitos.documentosObligatorios.requeridos).toEqual(["FACTURA_COMERCIAL"]);
    expect(requisitos.tarifaVigente.mensaje).toContain("para el servicio «Nacionalización desde zona franca»");
    expect(requisitos.servicio).toEqual({
      codigo: "NACIONALIZACION_ZF",
      nombre: "Nacionalización desde zona franca",
      claveTarifa: "NACIONALIZACION_ZF",
    });
    expect(requisitos.numeracion?.siguiente).toBe("DO.BGT26-0282");
  });
});
