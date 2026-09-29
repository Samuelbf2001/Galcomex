import type { Prisma } from "@prisma/client";

import { aJsonGuardado } from "@/lib/dinero";

/**
 * Convierte cualquier valor (con BigInt y Date) en JSON apto para columnas
 * `Json` de Prisma (AuditLog, `minimos`/`tramos`, `conceptosOperacionales`,
 * snapshots). Todos sus usos ESCRIBEN en BD, así que usa `aJsonGuardado`
 * (fase centavos A.5): `bigint` (centavos) → pesos texto CANÓNICO
 * (`43336100n` → `"433361"`, `50280145n` → `"502801.45"`), llaves sin el
 * sufijo `Centavos`, `Date` → ISO. El paso final por JSON deja fuera
 * `undefined` igual que antes.
 */
export function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(aJsonGuardado(value))) as Prisma.InputJsonValue;
}
