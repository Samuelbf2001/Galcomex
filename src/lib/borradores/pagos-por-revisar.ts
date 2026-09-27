/**
 * Pagos por revisar de un borrador — Galcomex
 *
 * Al generar un borrador, `generarBorrador` separa de cada pago lo que se le
 * cobra al cliente y lo que no (asesoría «NO SE COBRA», ver
 * `lib/calculations/pagos-cobrables.ts`). Cuando el sistema no puede saber
 * con certeza qué parte de un pago fue asesoría (su valor no cuadra con sus
 * facturas, la auditoría del pago en bloque es ambigua, el pago va suelto y el
 * trámite tiene asesoría que sus pagos enlazados no cubren, o su parte cobrable,
 * sola o sumada con otros pagos de las mismas facturas, paga de más facturas que
 * se cobran; ver `motivoRevisionPago`, `asesoriasSinCubrir` y
 * `sobranteCobradoPorGrupo`), ese pago queda en `pagosPorRevisar` de la auditoría
 * de creación del borrador (sin columna nueva en la BD). En el formato
 * CONCEPTOS_IVA lo cobrado sale de las facturas, no de los pagos: ahí la
 * lista va vacía.
 *
 * Este módulo lo lee de vuelta para mostrárselo a quien revisa (ADMIN y
 * REVISOR) tal como quedó al calcular ESE borrador: es la explicación de sus
 * totales. Nunca se muestra al SOCIO ni va a comentariosCabecera (viaja a
 * SIIGO y la ve el cliente).
 */

import { Prisma } from "@prisma/client";

import {
  MOTIVOS_REVISION_PAGO,
  type MotivoRevisionPago,
} from "@/lib/calculations/pagos-cobrables";
import { prisma } from "@/lib/db/prisma";

/** Roles que ven los pagos por revisar (costo interno: nunca el SOCIO). */
export const ROLES_VEN_PAGOS_POR_REVISAR: readonly string[] = ["ADMIN", "REVISOR"];

/** Pago cuyo reparto entre lo que se cobra y la asesoría no es seguro. */
export type PagoPorRevisar = {
  pagoId: string;
  concepto: string;
  numSoporte: string | null;
  /** Valor del pago (COP). */
  valor: bigint;
  /** Σ de lo que abona a sus facturas (monto conocido o valor de la factura). */
  sumaFacturas: bigint;
  /** Parte que se le cobró al cliente en el borrador. */
  cobrable: bigint;
  /** Parte que asumió Galcomex. */
  noCobrable: bigint;
  /**
   * Por qué hay que revisarlo (ver `MOTIVOS_REVISION_PAGO`). `null` si la
   * auditoría no lo trae (borradores generados antes de guardarlo).
   */
  motivo: MotivoRevisionPago | null;
};

const ENTERO = /^-?\d+$/;

function aMotivo(valor: unknown): MotivoRevisionPago | null {
  return typeof valor === "string" && (MOTIVOS_REVISION_PAGO as readonly string[]).includes(valor)
    ? (valor as MotivoRevisionPago)
    : null;
}

function aBigInt(valor: unknown): bigint | null {
  if (typeof valor === "bigint") return valor;
  if (typeof valor === "string" && ENTERO.test(valor)) return BigInt(valor);
  if (typeof valor === "number" && Number.isSafeInteger(valor)) return BigInt(valor);
  return null;
}

/**
 * Convierte `despues.pagosPorRevisar` de la auditoría (BigInt guardado como
 * texto) en la lista tipada. Descarta las entradas mal formadas (un motivo
 * ausente o desconocido queda en `null`); cualquier otra cosa (borradores
 * anteriores a este cambio) → lista vacía.
 */
export function pagosPorRevisarDesdeAuditoria(crudo: unknown): PagoPorRevisar[] {
  if (!Array.isArray(crudo)) return [];
  const lista: PagoPorRevisar[] = [];
  for (const item of crudo) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const valor = aBigInt(r.valor);
    const sumaFacturas = aBigInt(r.sumaFacturas);
    const cobrable = aBigInt(r.cobrable);
    const noCobrable = aBigInt(r.noCobrable);
    if (
      typeof r.pagoId !== "string" ||
      valor === null ||
      sumaFacturas === null ||
      cobrable === null ||
      noCobrable === null
    ) {
      continue;
    }
    lista.push({
      pagoId: r.pagoId,
      concepto: typeof r.concepto === "string" ? r.concepto : "",
      numSoporte: typeof r.numSoporte === "string" ? r.numSoporte : null,
      valor,
      sumaFacturas,
      cobrable,
      noCobrable,
      motivo: aMotivo(r.motivo),
    });
  }
  return lista;
}

/**
 * Pagos por revisar de cada borrador (borradorId → lista), leídos de su
 * auditoría de creación. Solo trae la parte `pagosPorRevisar` del JSON (no el
 * snapshot completo del borrador). Un borrador sin rastro → sin entrada.
 */
export async function leerPagosPorRevisar(
  borradorIds: readonly string[],
): Promise<Map<string, PagoPorRevisar[]>> {
  const resultado = new Map<string, PagoPorRevisar[]>();
  if (borradorIds.length === 0) return resultado;

  const filas = await prisma.$queryRaw<Array<{ entidadId: string; pagos: unknown }>>`
    SELECT "entidadId", "despues" -> 'pagosPorRevisar' AS "pagos"
    FROM "audit_log"
    WHERE "entidad" = 'BorradorFactura'
      AND "accion" = 'CREATE'
      AND "entidadId" IN (${Prisma.join([...borradorIds])})
  `;
  for (const fila of filas) {
    resultado.set(fila.entidadId, pagosPorRevisarDesdeAuditoria(fila.pagos));
  }
  return resultado;
}
