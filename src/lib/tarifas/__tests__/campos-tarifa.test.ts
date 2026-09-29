/**
 * B2 (Diseño B, 29-sep-2026) — qué le pide una tarifa al DO de «Otros
 * servicios». Puros (sin BD). Las tarifas de prueba son las de DISENO-B §9
 * (D5 nacionalización desde zona franca y D6 DUTA), con el motor de verdad:
 * cada caso también calcula la factura al peso para comprobar que lo que se
 * pide es exactamente lo que el motor necesita (ni un campo de más ni de menos).
 */
import { describe, expect, it } from "vitest";

import { camposQuePideTarifa } from "../campos-tarifa";
import { calcularLineasTarifa, type ContextoTarifa, type ItemTarifaCalculable } from "../motor";

const $ = (n: number) => BigInt(n);

function item(over: Partial<ItemTarifaCalculable> & Pick<ItemTarifaCalculable, "concepto" | "tipoCalculo" | "orden">): ItemTarifaCalculable {
  return {
    nombrePublico: over.concepto,
    siigoCodigo: null,
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    ...over,
  };
}

/** D5 — Nacionalización ZF (Polyrec Zona Franca). */
const NACIONALIZACION_ZF: ItemTarifaCalculable[] = [
  item({ concepto: "SERVICIO_NACIONALIZACION", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 30, minimos: { SUELTA: "400000", CONTENEDOR_20: "400000", CONTENEDOR_40: "400000" }, restaAgenciamiento: true, minimoEsDelTotal: true, orden: 10 }),
  item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: $(10_000), orden: 20 }),
  item({ concepto: "PAPELERIA", tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: $(12_000), orden: 30 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 }),
  item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 50 }),
  item({ concepto: "INSPECCION_DIAN", tipoCalculo: "FIJO", disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", valor: $(100_000), orden: 60 }),
];

/** D6 — DUTA (Polyrec ZF): cinco ítems fijos. */
const DUTA: ItemTarifaCalculable[] = [
  item({ concepto: "SERVICIO_DUTA", tipoCalculo: "FIJO", valor: $(240_000), orden: 10 }),
  item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "FIJO", valor: $(10_000), orden: 20 }),
  item({ concepto: "PAPELERIA", tipoCalculo: "FIJO", valor: $(10_000), orden: 30 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 }),
  item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 50 }),
];

const ctx = (over: Partial<ContextoTarifa> = {}): ContextoTarifa => ({
  valorCif: null,
  tipoCarga: null,
  numContenedores: null,
  numDeclaraciones: null,
  numDocumentos: null,
  numItems: null,
  eventos: [],
  costos: [],
  ...over,
});

describe("camposQuePideTarifa", () => {
  it("nacionalización ZF: CIF, tipo de carga, declaraciones, documentos, la inspección y la agencia", () => {
    expect(camposQuePideTarifa(NACIONALIZACION_ZF)).toEqual({
      base: ["valorCif", "tipoCarga", "numDeclaraciones", "numDocumentos"],
      eventos: ["REVISION_DESPACHO"],
      agencia: true,
    });
  });

  it("DUTA: no pide nada del DO (todo fijo, sin CIF ni agencia)", () => {
    expect(camposQuePideTarifa(DUTA)).toEqual({ base: [], eventos: [], agencia: false });
  });

  it("sin ítems (Plan Vallejo y sellos van con valor a mano): no pide nada", () => {
    expect(camposQuePideTarifa([])).toEqual({ base: [], eventos: [], agencia: false });
  });

  it("PORCENTAJE_MIN sin mínimos pide el CIF pero no el tipo de carga", () => {
    const r = camposQuePideTarifa([item({ concepto: "SERVICIO", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 37, orden: 1 })]);
    expect(r.base).toEqual(["valorCif"]);
  });

  it("cada unidad pide su propio campo: contenedores, declaraciones, documentos, ítems; trámite y mes no piden nada", () => {
    const porUnidad = (unidad: ItemTarifaCalculable["unidad"], tipoCalculo: ItemTarifaCalculable["tipoCalculo"] = "POR_UNIDAD") =>
      camposQuePideTarifa([item({ concepto: "X", tipoCalculo, unidad, valor: $(1), tramos: [{ hasta: null, valor: "1" }], orden: 1 })]).base;
    expect(porUnidad("CONTENEDOR")).toEqual(["numContenedores"]);
    expect(porUnidad("DECLARACION")).toEqual(["numDeclaraciones"]);
    expect(porUnidad("DOCUMENTO")).toEqual(["numDocumentos"]);
    expect(porUnidad("ITEM", "PRIMERO_MAS_ADICIONAL")).toEqual(["numItems"]);
    expect(porUnidad("CONTENEDOR", "POR_TRAMO")).toEqual(["numContenedores"]);
    expect(porUnidad("TRAMITE")).toEqual([]);
    expect(porUnidad("MES")).toEqual([]);
  });

  it("un ítem por evento usa la cantidad del evento: pide el evento, no el campo de la base", () => {
    const r = camposQuePideTarifa([
      item({ concepto: "X", tipoCalculo: "POR_UNIDAD", unidad: "CONTENEDOR", disparador: "EVENTO", eventoCodigo: "INGRESO_ZF", valor: $(1), orden: 1 }),
    ]);
    expect(r).toEqual({ base: [], eventos: ["INGRESO_ZF"], agencia: false });
  });

  it("los ítems manuales no piden nada; los eventos no se repiten; el orden de los campos es el de la pantalla", () => {
    const r = camposQuePideTarifa([
      item({ concepto: "A", tipoCalculo: "FIJO", disparador: "MANUAL", valor: $(1), orden: 1, unidad: "DOCUMENTO" }),
      item({ concepto: "B", tipoCalculo: "POR_UNIDAD", unidad: "ITEM", valor: $(1), orden: 2 }),
      item({ concepto: "C", tipoCalculo: "FIJO", disparador: "EVENTO", eventoCodigo: "E1", valor: $(1), orden: 3 }),
      item({ concepto: "D", tipoCalculo: "FIJO", disparador: "EVENTO", eventoCodigo: "E1", valor: $(2), orden: 4 }),
      item({ concepto: "E", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 10, orden: 5 }),
    ]);
    expect(r).toEqual({ base: ["valorCif", "numItems"], eventos: ["E1"], agencia: false });
  });
});

describe("lo que pide la tarifa es lo que el motor necesita (dorados N1, N2, N4, N5 al peso)", () => {
  const coldex = { agencia: "COLDEX", valor: $(145_000) };

  it("N1 — DO.26-0171: CIF 51.066.071, suelta, 1 declaración, 2 documentos, agencia COLDEX → 407.000", () => {
    const r = calcularLineasTarifa(
      NACIONALIZACION_ZF,
      ctx({ valorCif: $(51_066_071), tipoCarga: "SUELTA", numDeclaraciones: 1, numDocumentos: 2, agenciamiento: coldex }),
    );
    expect(r.pendientes).toEqual([]);
    expect(r.lineas.map((l) => l.valor)).toEqual([$(255_000), $(20_000), $(12_000), $(20_000), $(100_000)]);
    expect(r.total).toBe($(407_000));
  });

  it("N2 — DO.26-0130: CIF 45.454.209, 2 declaraciones, 4 documentos, inspección → 539.000", () => {
    const r = calcularLineasTarifa(
      NACIONALIZACION_ZF,
      ctx({
        valorCif: $(45_454_209),
        tipoCarga: "SUELTA",
        numDeclaraciones: 2,
        numDocumentos: 4,
        agenciamiento: coldex,
        eventos: [{ codigo: "REVISION_DESPACHO", cantidad: 1 }],
      }),
    );
    expect(r.lineas.map((l) => l.valor)).toEqual([$(255_000), $(40_000), $(24_000), $(20_000), $(100_000), $(100_000)]);
    expect(r.total).toBe($(539_000));
  });

  it("N3 — sin marcar la inspección: 439.000 (la OC de 539.000 lo frenará en B4)", () => {
    const r = calcularLineasTarifa(
      NACIONALIZACION_ZF,
      ctx({ valorCif: $(45_454_209), tipoCarga: "SUELTA", numDeclaraciones: 2, numDocumentos: 4, agenciamiento: coldex }),
    );
    expect(r.total).toBe($(439_000));
  });

  it("N4 — Z7c, CIF 150.000.000: el servicio pasa del mínimo → 305.000 (0,30 % = 450.000 − Coldex 145.000)", () => {
    const r = calcularLineasTarifa(
      NACIONALIZACION_ZF,
      ctx({ valorCif: $(150_000_000), tipoCarga: "SUELTA", numDeclaraciones: 1, numDocumentos: 2, agenciamiento: coldex }),
    );
    expect(r.lineas[0]!.valor).toBe($(305_000));
    expect(r.total).toBe($(457_000));
  });

  it("N5 — DUTA como «Otros»: 240.000 + 10.000 + 10.000 + 20.000 + 100.000 = 380.000, sin pedirle nada al DO", () => {
    const r = calcularLineasTarifa(DUTA, ctx());
    expect(r.pendientes).toEqual([]);
    expect(r.lineas.map((l) => l.valor)).toEqual([$(240_000), $(10_000), $(10_000), $(20_000), $(100_000)]);
    expect(r.total).toBe($(380_000));
  });

  it("si falta lo que la tarifa pide, el motor deja pendiente cada dato (nunca cobra un cero en silencio)", () => {
    const pedidos = camposQuePideTarifa(NACIONALIZACION_ZF);
    const r = calcularLineasTarifa(NACIONALIZACION_ZF, ctx({ agenciamiento: coldex }));
    // Sin CIF, sin documentos y sin declaraciones: 3 pendientes, uno por cada campo pedido que falta.
    expect(r.pendientes.map((p) => p.concepto).sort()).toEqual(["PAPELERIA", "REVISION_DOCUMENTAL", "SERVICIO_NACIONALIZACION"]);
    expect(pedidos.base).toContain("valorCif");
  });
});
