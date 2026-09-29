/**
 * Documentos exigidos por el checklist — funciones PURAS (cliente y servidor).
 *
 * Revisión de Ernesto (24-sep-2026, reunión del 31-ago min 40–50): los
 * documentos que pide un evento del DO se suben desde el propio requisito
 * ("Fotos de la revisión de la carga" → las fotos que manda el Sr. Lucho).
 * Aquí se decide en qué categoría (carpeta del DO) cae cada archivo.
 */

import type { CategoriaDocumento } from "@prisma/client";

/**
 * Orden importa: la primera regla que coincide gana. "Comprobante de pago del
 * registro" es un comprobante, no el registro; "Factura comercial" no es una
 * factura de proveedor.
 */
const REGLAS: ReadonlyArray<{ patron: RegExp; categoria: CategoriaDocumento }> = [
  { patron: /\bfotos?\b|reconocimiento|inspecci[oó]n/, categoria: "FOTO_RECONOCIMIENTO" },
  { patron: /comprobante|\bpago\b/, categoria: "COMPROBANTE_BANCARIO" },
  { patron: /factura comercial/, categoria: "FACTURA_COMERCIAL" },
  { patron: /\bbl\b|bill of lading|gu[ií]a/, categoria: "BL" },
  { patron: /packing/, categoria: "PACKING_LIST" },
  { patron: /declaraci[oó]n|\bdian\b/, categoria: "DECLARACION_DIAN" },
  { patron: /orden de compra/, categoria: "ORDEN_COMPRA" },
  { patron: /ficha t[eé]cnica|hoja de seguridad|certificado/, categoria: "FICHA_TECNICA" },
];

/** Categoría con la que se guarda un archivo subido desde un requisito del checklist. */
export function categoriaParaRequisito(descripcion: string): CategoriaDocumento {
  const texto = descripcion.toLowerCase();
  return REGLAS.find((r) => r.patron.test(texto))?.categoria ?? "OTRO";
}

/** "1 archivo", "12 archivos". */
export function textoArchivos(n: number): string {
  return `${n} ${n === 1 ? "archivo" : "archivos"}`;
}
