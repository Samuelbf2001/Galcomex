/**
 * Regla PURA de "¿esta línea necesita producto Siigo para poder enviarse?".
 *
 * Reusa `lineasQueVanComoItem` (el mismo filtro que usa el armador real de
 * ítems para Siigo, `src/lib/siigo/items-factura.ts`) para que el aviso en
 * pantalla nunca se desalinee de lo que de verdad se envía. De ese módulo solo
 * se importa un tipo — la función que sí se ejecuta aquí no toca red ni BD.
 */

import { lineasQueVanComoItem } from "@/lib/siigo/items-factura";

export type LineaAvisoProducto = {
  valor: string;
  tipoFija: string | null;
  siigoProductoId?: string | null;
};

/** ¿Esta línea viajaría como ítem a Siigo con el formato de factura dado? */
export function lineaVaASiigo(
  l: LineaAvisoProducto,
  formato: string | null | undefined,
): boolean {
  let valorBigInt: bigint;
  try {
    valorBigInt = BigInt(l.valor);
  } catch {
    return false;
  }
  return (
    lineasQueVanComoItem(
      [{ valor: valorBigInt, tipoFija: l.tipoFija }],
      formato ?? "COMISION",
    ).length === 1
  );
}

/** La línea viajaría a Siigo pero no tiene producto asignado: no se podrá enviar. */
export function lineaSinProductoSiigo(
  l: LineaAvisoProducto,
  formato: string | null | undefined,
): boolean {
  return lineaVaASiigo(l, formato) && !l.siigoProductoId;
}

/** Cuenta cuántas líneas del borrador viajarían a Siigo sin producto asignado. */
export function contarLineasSinProducto(
  lineas: LineaAvisoProducto[],
  formato: string | null | undefined,
): number {
  return lineas.filter((l) => lineaSinProductoSiigo(l, formato)).length;
}

/**
 * Texto del aviso "N línea(s) sin producto SIIGO", según el estado del
 * borrador y si quien mira puede editarlo. `null` = no mostrar el aviso.
 *
 * - FACTURADO: la factura ya existe (o se marcó a mano desde el Excel de
 *   importación, que no usa productos) — no hay nada que hacer aquí, y
 *   "devuelve el borrador a BORRADOR" es imposible (`TRANSICIONES_DEVOLUCION`
 *   no admite salir de FACTURADO).
 * - `puedeEditar`: quien mira puede asignar el producto ahora mismo.
 * - BORRADOR / EN_REVISION sin poder editar (p. ej. rol OPERATIVO/REVISOR, o
 *   SOCIO fuera de su propio trámite): no puede devolver el borrador a
 *   BORRADOR porque ya está ahí (o esa acción no es suya) — solo puede pedirle
 *   a un ADMIN/SOCIO que asigne el producto.
 * - APROBADO (o cualquier otro estado sin editar): sí existe una devolución a
 *   BORRADOR válida, así que se pide esa acción a quien puede hacerla (ADMIN o
 *   REVISOR — ver `puedeDevolver` en `revisor-borrador.tsx`).
 */
export function mensajeSinProductoSiigo(
  estado: string | null | undefined,
  puedeEditar: boolean,
): string | null {
  if (estado === "FACTURADO") return null;
  if (puedeEditar) {
    return "Elige el producto en cada línea marcada. Sin producto, la factura no se podrá enviar a SIIGO.";
  }
  if (estado === "BORRADOR" || estado === "EN_REVISION") {
    return "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN que asigne el producto.";
  }
  return "Sin producto, la factura no se podrá enviar a SIIGO. Pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR para asignar el producto.";
}

/** El aviso rojo de cada línea se oculta en FACTURADO (ver `mensajeSinProductoSiigo`). */
export function ocultarAvisoPorLinea(estado: string | null | undefined): boolean {
  return estado === "FACTURADO";
}
