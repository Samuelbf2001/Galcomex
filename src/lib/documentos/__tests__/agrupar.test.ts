/**
 * Test unitario puro (sin BD) del agrupamiento genérico usado para mostrar
 * los documentos de un cliente por categoría en la UI.
 */
import { describe, expect, it } from "vitest";

import { agruparPor } from "../agrupar";

describe("agruparPor", () => {
  it("devuelve objeto vacío para lista vacía", () => {
    expect(agruparPor([], (x: string) => x)).toEqual({});
  });

  it("agrupa elementos por la clave calculada", () => {
    const items = [
      { categoria: "BL", nombre: "bl-1" },
      { categoria: "FACTURA_COMERCIAL", nombre: "fc-1" },
      { categoria: "BL", nombre: "bl-2" },
    ];

    const result = agruparPor(items, (i) => i.categoria);

    expect(Object.keys(result).sort()).toEqual(["BL", "FACTURA_COMERCIAL"]);
    expect(result.BL).toHaveLength(2);
    expect(result.FACTURA_COMERCIAL).toHaveLength(1);
  });

  it("preserva el orden original dentro de cada grupo", () => {
    const items = [
      { categoria: "BL", id: 1 },
      { categoria: "BL", id: 2 },
      { categoria: "BL", id: 3 },
    ];

    const result = agruparPor(items, (i) => i.categoria);

    expect(result.BL.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("no muta el arreglo de entrada", () => {
    const items = [{ categoria: "OTRO", id: 1 }];
    const copy = [...items];

    agruparPor(items, (i) => i.categoria);

    expect(items).toEqual(copy);
  });
});
