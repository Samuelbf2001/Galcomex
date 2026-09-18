import { describe, expect, it } from "vitest";

import { resolverLineaConcepto, type ConceptoParaLinea } from "../nombre-linea";

/** Producto real del catálogo Siigo de Galcomex (83 productos, 14-sep-2026). */
const GASTOS_OPERATIVOS = { id: "prod-005", codigo: "005", nombre: "GASTOS OPERATIVOS" };
const SERVICIO_LOGISTICO = { id: "prod-007", codigo: "007", nombre: "SERVICIO LOGÍSTICO" };

const CONCEPTO: ConceptoParaLinea = {
  codigo: "GASTOS_TRAMITE",
  nombre: "Gastos de trámite por embarque",
  aplicaIva: true,
  siigoProducto: GASTOS_OPERATIVOS,
};

describe("resolverLineaConcepto — el nombre de la factura es el del producto Siigo", () => {
  it("1º el producto del ítem del tarifario", () => {
    const r = resolverLineaConcepto({
      nombrePublico: "Gastos de trámite por contenedor",
      productoDelItem: SERVICIO_LOGISTICO,
      concepto: CONCEPTO,
    });
    expect(r).toEqual({
      nombre: "SERVICIO LOGÍSTICO",
      siigoProductoId: "prod-007",
      siigoCodigo: "007",
      aplicaIva: true,
      origenNombre: "PRODUCTO_ITEM",
    });
  });

  it("2º el producto por defecto del concepto cuando el ítem no trae", () => {
    const r = resolverLineaConcepto({
      nombrePublico: "Gastos de trámite por embarque",
      productoDelItem: null,
      concepto: CONCEPTO,
    });
    expect(r.nombre).toBe("GASTOS OPERATIVOS");
    expect(r.siigoProductoId).toBe("prod-005");
    expect(r.origenNombre).toBe("PRODUCTO_CONCEPTO");
  });

  it("3º el nombre del concepto cuando todavía no hay producto asignado", () => {
    const r = resolverLineaConcepto({
      nombrePublico: "Gastos de trámite por embarque",
      productoDelItem: null,
      concepto: { ...CONCEPTO, siigoProducto: null },
    });
    expect(r.nombre).toBe("Gastos de trámite por embarque");
    expect(r.siigoProductoId).toBeNull();
    expect(r.origenNombre).toBe("CONCEPTO");
  });

  it("4º el nombre público del ítem si el concepto no está en el maestro (nada se rompe)", () => {
    const r = resolverLineaConcepto({
      nombrePublico: "Traslado de contenedor en zona franca",
      productoDelItem: null,
      concepto: null,
    });
    expect(r).toEqual({
      nombre: "Traslado de contenedor en zona franca",
      siigoProductoId: null,
      siigoCodigo: null,
      aplicaIva: true,
      origenNombre: "NOMBRE_PUBLICO",
    });
  });
});

describe("resolverLineaConcepto — IVA", () => {
  it("el IVA explícito del ítem manda sobre el del concepto", () => {
    expect(
      resolverLineaConcepto({
        nombrePublico: "Pago del registro (VUCE)",
        productoDelItem: null,
        concepto: CONCEPTO,
        aplicaIvaItem: false,
      }).aplicaIva,
    ).toBe(false);
  });

  it("sin IVA explícito toma el del concepto", () => {
    expect(
      resolverLineaConcepto({
        nombrePublico: "Sellos de seguridad",
        productoDelItem: null,
        concepto: { ...CONCEPTO, aplicaIva: false },
        aplicaIvaItem: null,
      }).aplicaIva,
    ).toBe(false);
  });

  it("sin ítem ni concepto, grava (comportamiento histórico)", () => {
    expect(
      resolverLineaConcepto({ nombrePublico: "X", productoDelItem: null, concepto: null }).aplicaIva,
    ).toBe(true);
  });
});

describe("resolverLineaConcepto — bordes", () => {
  it("un producto con nombre en blanco no deja la línea sin nombre", () => {
    const r = resolverLineaConcepto({
      nombrePublico: "Papelería",
      productoDelItem: { id: "p", codigo: "003", nombre: "   " },
      concepto: null,
    });
    expect(r.nombre).toBe("Papelería");
    // El producto sigue siendo el de la línea aunque el nombre no sirva.
    expect(r.siigoProductoId).toBe("p");
    expect(r.origenNombre).toBe("NOMBRE_PUBLICO");
  });
});
