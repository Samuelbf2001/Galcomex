/**
 * Bloqueo de DOs para CxP v2 (diseño §B.5).
 *
 * Orden ÚNICO de bloqueo en toda mutación de cuentas por pagar y en la
 * transición a CERRADO:
 *   (1) cabecera de idempotencia (si aplica)
 *   (2) `bloquearTramites` (DOs, orden por id)
 *   (3) `bloquearFacturas` (facturas, orden por id — P1, `aplicar.ts`)
 * Siempre DOs antes que facturas → sin deadlocks entre pago, anulación, borrado
 * de pago y cierre del DO.
 *
 * Lo usan P1 (pagos, anulación de bloque, borrado de pago) y P2 (transición a
 * CERRADO) sin compartir archivo. Debe llamarse DENTRO de una transacción
 * interactiva (`prisma.$transaction(async (tx) => …)`): el bloqueo dura hasta
 * el COMMIT/ROLLBACK.
 */

import { Prisma } from "@prisma/client";

/**
 * `SELECT id FROM "tramite_do" WHERE id = ANY($1) ORDER BY id FOR UPDATE`.
 * Ids repetidos se ignoran. Devuelve los ids que existen (ordenados); los que
 * no existen simplemente no vuelven (el llamador decide si es un 404).
 */
export async function bloquearTramites(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<string[]> {
  const unicos = [...new Set(ids)].sort();
  if (unicos.length === 0) return [];
  const filas = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM "tramite_do" WHERE id = ANY(${unicos}::text[]) ORDER BY id FOR UPDATE`,
  );
  return filas.map((f) => f.id);
}
