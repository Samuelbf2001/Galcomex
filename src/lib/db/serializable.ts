import type { Prisma } from "@prisma/client";

/**
 * Convierte cualquier valor (con BigInt y Date) en JSON apto para columnas
 * `Json` de Prisma (snapshots de AuditLog, etc.). BigInt → string decimal.
 */
export function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}
