/**
 * Plan de sincronización producto Siigo ↔ impuestos — función PURA, sin BD.
 *
 * `GET /v1/products` devuelve `taxes: [{id,name,type,percentage}]` por producto.
 * Hasta ahora `sync-service.ts` los ignoraba y `siigo_producto_impuesto` se
 * llenaba a mano con `PUT /api/configuracion/siigo/productos/{id}/impuestos`.
 *
 * Regla: el sync manda sobre lo que él mismo creó (`origen = SIIGO`) y NUNCA
 * toca lo que puso una persona (`origen = MANUAL`), ni siquiera para
 * "ascenderlo" a SIIGO. Así una asociación manual sigue siendo un override
 * explícito que ningún sync borra.
 */

export type OrigenImpuesto = "SIIGO" | "MANUAL";

export interface FilaProductoImpuesto {
  impuestoId: number;
  origen: OrigenImpuesto;
}

export interface PlanImpuestosProducto {
  /** Filas a crear con `origen = SIIGO`. */
  crear: number[];
  /** Filas `origen = SIIGO` que Siigo ya no reporta y hay que borrar. */
  borrar: number[];
  /** Filas manuales que se dejan como están (solo para el log). */
  conservarManual: number[];
}

/**
 * @param taxesDeSiigo Impuestos que el producto trae en `/v1/products`.
 * @param existentes   Filas actuales de `siigo_producto_impuesto` del producto.
 */
export function planImpuestosProducto(
  taxesDeSiigo: readonly { id: number }[],
  existentes: readonly FilaProductoImpuesto[],
): PlanImpuestosProducto {
  const deseados = [...new Set(taxesDeSiigo.map((t) => t.id))];
  const yaEstan = new Set(existentes.map((e) => e.impuestoId));
  const deSiigo = existentes.filter((e) => e.origen === "SIIGO").map((e) => e.impuestoId);
  const manuales = existentes.filter((e) => e.origen === "MANUAL").map((e) => e.impuestoId);

  return {
    crear: deseados.filter((id) => !yaEstan.has(id)),
    borrar: deSiigo.filter((id) => !deseados.includes(id)),
    conservarManual: manuales,
  };
}

/**
 * Id del IVA que hay que mandarle a Siigo en la línea de un producto.
 *
 * Solo se usa el impuesto del producto cuando su porcentaje COINCIDE con la
 * tasa con la que el motor liquidó la factura: si difiere, Siigo calcularía un
 * IVA distinto al nuestro y `payments.value` no cuadraría (tolerancia 0).
 * En ese caso se cae al IVA global, que es el comportamiento actual.
 */
export function ivaDelProducto(
  impuestos: readonly { id: number; tipo: string; porcentaje: string }[],
  tasaIva: bigint,
): number | null {
  const iva = impuestos.find(
    (i) => i.tipo === "IVA" && Number(i.porcentaje) === Number(tasaIva),
  );
  return iva?.id ?? null;
}
