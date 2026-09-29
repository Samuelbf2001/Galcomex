/**
 * B1 (Diseño A, 27-sep-2026) — el estándar de agenciamiento por agencia de
 * aduanas. Único lugar que interpreta el texto del `Parametro
 * AGENCIAMIENTO_<AGENCIA>` (fase centavos cambia solo esta línea:
 * `BigInt(valor)` → `centavosDeTexto(valor)`).
 */

import type { AgenciaAduanas } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export interface AgenciamientoEstandar {
  agencia: string | null;
  valor: bigint | null;
}

/**
 * Lee `Parametro AGENCIAMIENTO_<AGENCIA>` para la agencia del DO. Sin agencia
 * → `{ agencia: null, valor: null }`. Sin fila, o valor vacío/no numérico →
 * `valor: null` (pendiente, nunca inventa un cero).
 */
export async function agenciamientoEstandarDe(
  agencia: AgenciaAduanas | null,
): Promise<AgenciamientoEstandar> {
  if (!agencia) return { agencia: null, valor: null };

  const parametro = await prisma.parametro.findUnique({
    where: { clave: `AGENCIAMIENTO_${agencia}` },
    select: { valor: true },
  });

  if (!parametro || !/^\d+$/.test(parametro.valor)) {
    return { agencia, valor: null };
  }

  return { agencia, valor: BigInt(parametro.valor) };
}
