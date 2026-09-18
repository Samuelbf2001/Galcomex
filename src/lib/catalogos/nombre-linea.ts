/**
 * Regla de nombre de la línea de factura — función PURA, sin BD.
 *
 * Decisión de la reunión del 10-sep-2026 (Camila, min 03:46): el nombre del
 * concepto en la plataforma y en la factura Siigo debe ser EL MISMO. Hasta hoy
 * cada `TarifaItem` guardaba su `nombrePublico` por empresa y las facturas
 * reales rotaban cuatro variantes del mismo producto 005/007.
 *
 * Orden de resolución (ver docs/CATALOGOS.md §1):
 *   1. Producto Siigo del ítem del tarifario (`siigoCodigo`).
 *   2. Producto Siigo por defecto del concepto del maestro.
 *   3. Nombre del concepto del maestro.
 *   4. `nombrePublico` del ítem — comportamiento actual, para que nada se rompa
 *      mientras los conceptos no estén enlazados.
 */

export interface ProductoSiigoRef {
  id: string;
  codigo: string;
  nombre: string;
}

export interface ConceptoParaLinea {
  codigo: string;
  nombre: string;
  aplicaIva: boolean;
  siigoProducto: ProductoSiigoRef | null;
}

export interface EntradaLineaConcepto {
  /** Nombre que trae el ítem del tarifario (o el texto que escribió el revisor). */
  nombrePublico: string;
  /** Producto ya resuelto desde `tarifa_item.siigoCodigo`; null si no lo trae o no existe. */
  productoDelItem: ProductoSiigoRef | null;
  /** Concepto del maestro, si el ítem está enlazado. */
  concepto: ConceptoParaLinea | null;
  /** IVA explícito del ítem. `null`/`undefined` toma el del concepto (o true). */
  aplicaIvaItem?: boolean | null;
}

export interface LineaConceptoResuelta {
  /** Nombre que va a la línea del borrador y al `description` del ítem Siigo. */
  nombre: string;
  siigoProductoId: string | null;
  siigoCodigo: string | null;
  aplicaIva: boolean;
  /** De dónde salió el nombre — para explicarlo en la UI y en el AuditLog. */
  origenNombre: "PRODUCTO_ITEM" | "PRODUCTO_CONCEPTO" | "CONCEPTO" | "NOMBRE_PUBLICO";
}

export function resolverLineaConcepto(entrada: EntradaLineaConcepto): LineaConceptoResuelta {
  const productoConcepto = entrada.concepto?.siigoProducto ?? null;
  const producto = entrada.productoDelItem ?? productoConcepto;

  const nombreProducto = producto?.nombre.trim() ?? "";
  const nombreConcepto = entrada.concepto?.nombre.trim() ?? "";

  const origenNombre: LineaConceptoResuelta["origenNombre"] = nombreProducto
    ? entrada.productoDelItem
      ? "PRODUCTO_ITEM"
      : "PRODUCTO_CONCEPTO"
    : nombreConcepto
      ? "CONCEPTO"
      : "NOMBRE_PUBLICO";

  return {
    nombre: nombreProducto || nombreConcepto || entrada.nombrePublico,
    siigoProductoId: producto?.id ?? null,
    siigoCodigo: producto?.codigo ?? null,
    aplicaIva: entrada.aplicaIvaItem ?? entrada.concepto?.aplicaIva ?? true,
    origenNombre,
  };
}
