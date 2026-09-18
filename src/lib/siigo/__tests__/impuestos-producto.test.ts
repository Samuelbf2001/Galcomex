import { describe, expect, it } from "vitest";

import {
  ivaDelProducto,
  planImpuestosProducto,
  type FilaProductoImpuesto,
} from "../impuestos-producto";

/** Ids reales del catálogo Siigo de Galcomex (ya sincronizados). */
const IVA_19 = 1564;
const RETEIVA_15 = 1578;
const IVA_5 = 1565;

describe("planImpuestosProducto — el sync no pisa lo que se puso a mano", () => {
  it("un producto sin filas previas crea todas las que trae Siigo", () => {
    expect(planImpuestosProducto([{ id: IVA_19 }], [])).toEqual({
      crear: [IVA_19],
      borrar: [],
      conservarManual: [],
    });
  });

  it("es idempotente: correr el sync dos veces no cambia nada", () => {
    const existentes: FilaProductoImpuesto[] = [{ impuestoId: IVA_19, origen: "SIIGO" }];
    expect(planImpuestosProducto([{ id: IVA_19 }], existentes)).toEqual({
      crear: [],
      borrar: [],
      conservarManual: [],
    });
  });

  it("borra las filas SIIGO que Siigo ya no reporta", () => {
    const existentes: FilaProductoImpuesto[] = [
      { impuestoId: IVA_19, origen: "SIIGO" },
      { impuestoId: IVA_5, origen: "SIIGO" },
    ];
    expect(planImpuestosProducto([{ id: IVA_19 }], existentes)).toEqual({
      crear: [],
      borrar: [IVA_5],
      conservarManual: [],
    });
  });

  it("NUNCA borra un override manual, aunque Siigo no lo reporte", () => {
    const existentes: FilaProductoImpuesto[] = [
      { impuestoId: RETEIVA_15, origen: "MANUAL" },
      { impuestoId: IVA_5, origen: "SIIGO" },
    ];
    expect(planImpuestosProducto([{ id: IVA_19 }], existentes)).toEqual({
      crear: [IVA_19],
      borrar: [IVA_5],
      conservarManual: [RETEIVA_15],
    });
  });

  it("no duplica una fila manual que Siigo también reporta (se queda MANUAL)", () => {
    const existentes: FilaProductoImpuesto[] = [{ impuestoId: IVA_19, origen: "MANUAL" }];
    expect(planImpuestosProducto([{ id: IVA_19 }], existentes)).toEqual({
      crear: [],
      borrar: [],
      conservarManual: [IVA_19],
    });
  });

  it("deduplica los taxes repetidos que a veces manda Siigo", () => {
    expect(planImpuestosProducto([{ id: IVA_19 }, { id: IVA_19 }], []).crear).toEqual([IVA_19]);
  });

  it("un producto sin taxes no borra nada", () => {
    const existentes: FilaProductoImpuesto[] = [{ impuestoId: IVA_19, origen: "SIIGO" }];
    expect(planImpuestosProducto([], existentes)).toEqual({
      crear: [],
      borrar: [IVA_19],
      conservarManual: [],
    });
  });
});

describe("ivaDelProducto — solo sirve si el porcentaje coincide con el del motor", () => {
  const impuestos = [
    { id: IVA_19, tipo: "IVA", porcentaje: "19.00" },
    { id: RETEIVA_15, tipo: "ReteIVA", porcentaje: "15.00" },
  ];

  it("devuelve el IVA del producto cuando la tasa es la misma", () => {
    expect(ivaDelProducto(impuestos, 19n)).toBe(IVA_19);
  });

  it("ignora las retenciones", () => {
    expect(ivaDelProducto([{ id: RETEIVA_15, tipo: "ReteIVA", porcentaje: "15.00" }], 19n)).toBeNull();
  });

  it("si el producto tiene IVA 5 % y el motor liquidó 19 %, no se usa (los totales no cuadrarían)", () => {
    expect(ivaDelProducto([{ id: IVA_5, tipo: "IVA", porcentaje: "5.00" }], 19n)).toBeNull();
  });

  it("un producto sin impuestos devuelve null", () => {
    expect(ivaDelProducto([], 19n)).toBeNull();
  });
});
