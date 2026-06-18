/**
 * Servicio de parámetros del sistema — Galcomex
 * Lee la tabla Parametro y convierte los valores string a BigInt escalados
 * que espera el motor de cálculo.
 *
 * Conversiones (deuda conocida resuelta aquí):
 *   IVA_COMISION   "0.19"   → tasaIva        = 19n   (porcentaje entero)
 *   TASA_4X1000    "0.004"  → tasa4x1000     = 400n  (escalado /100_000)
 *   COMISION_LM    "150000" → comisionDefault = 150_000n (COP BigInt)
 *   DIAS_SLA_FACTURA "3"    → diasSla        = 3     (number)
 */

import { prisma } from "@/lib/db/prisma";

export type ParametrosSistema = {
  tasaIva: bigint;        // 19n para 19%
  tasa4x1000: bigint;     // 400n = 0.4% (escalado /100_000)
  comisionDefault: bigint; // 150_000n COP
  diasSla: number;        // 3 días
};

/**
 * Lee los parámetros del sistema desde la BD y los convierte a las unidades
 * que espera calcularBorrador().
 *
 * Lanza si faltan claves obligatorias en la tabla Parametro.
 */
export async function getParametrosSistema(): Promise<ParametrosSistema> {
  const claves = ["IVA_COMISION", "TASA_4X1000", "COMISION_LM", "DIAS_SLA_FACTURA"] as const;

  const rows = await prisma.parametro.findMany({
    where: { clave: { in: [...claves] } },
    select: { clave: true, valor: true },
  });

  const map = new Map<string, string>(rows.map((r) => [r.clave, r.valor]));

  for (const clave of claves) {
    if (!map.has(clave)) {
      throw new Error(`Parámetro obligatorio '${clave}' no encontrado en la tabla Parametro`);
    }
  }

  // IVA_COMISION "0.19" → 19n
  const tasaIva = BigInt(Math.round(parseFloat(map.get("IVA_COMISION")!) * 100));

  // TASA_4X1000 "0.004" → 400n (= 0.4% expresado como entero /100_000)
  const tasa4x1000 = BigInt(Math.round(parseFloat(map.get("TASA_4X1000")!) * 100_000));

  // COMISION_LM "150000" → 150_000n
  const comisionDefault = BigInt(map.get("COMISION_LM")!);

  // DIAS_SLA_FACTURA "3" → 3
  const diasSla = parseInt(map.get("DIAS_SLA_FACTURA")!, 10);

  return { tasaIva, tasa4x1000, comisionDefault, diasSla };
}
