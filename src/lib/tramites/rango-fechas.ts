import type { Prisma } from "@prisma/client";

/**
 * Filtros de fecha de la lista de trámites (2-oct-2026). Función PURA: solo
 * arma el filtro de Prisma, sin BD — se prueba sin levantar Postgres.
 */

const UN_DIA_MS = 24 * 60 * 60 * 1000;
/** Colombia es UTC−5 todo el año: el día en Bogotá empieza a las 05:00 UTC. */
export const OFFSET_BOGOTA_MS = 5 * 60 * 60 * 1000;

/**
 * Filtro de Prisma para un rango de días calendario con ambos extremos
 * incluidos: `[desde 00:00, día siguiente a hasta 00:00)` desplazado
 * `desplazamientoMs` (0 para fechas-calendario guardadas a 00:00 UTC, como la
 * ETA; `OFFSET_BOGOTA_MS` para instantes que se leen en hora de Bogotá, como
 * la apertura = createdAt). Sin extremos → null.
 */
export function rangoDiasCalendario(
  desde: string | undefined,
  hasta: string | undefined,
  desplazamientoMs: number,
): Prisma.DateTimeFilter | null {
  if (!desde && !hasta) return null;
  const filtro: Prisma.DateTimeFilter = {};
  if (desde) {
    filtro.gte = new Date(Date.parse(`${desde}T00:00:00.000Z`) + desplazamientoMs);
  }
  if (hasta) {
    filtro.lt = new Date(Date.parse(`${hasta}T00:00:00.000Z`) + UN_DIA_MS + desplazamientoMs);
  }
  return filtro;
}
