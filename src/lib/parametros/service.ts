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

// ─── Lectores genéricos de parámetros ─────────────────────────────────────────
// Los umbrales de alerta definidos en la reunión del 1-jul-2026 son política de
// negocio, no constantes de código: Galcomex los ajusta desde Configuración.
// Estos lectores nunca lanzan por clave ausente — devuelven el default para que
// una BD sin sembrar no tumbe el flujo operativo.

/** Lee un parámetro como texto crudo. `null` si la clave no existe. */
export async function getParametro(clave: string): Promise<string | null> {
  const row = await prisma.parametro.findUnique({
    where: { clave },
    select: { valor: true },
  });
  return row?.valor ?? null;
}

/**
 * Lee un parámetro como COP entero (BigInt). Devuelve `fallback` si la clave no
 * existe o el valor no es un entero decimal válido.
 */
export async function getParametroBigInt(clave: string, fallback: bigint): Promise<bigint> {
  const valor = await getParametro(clave);
  if (valor === null) return fallback;
  const limpio = valor.trim();
  if (!/^-?\d+$/.test(limpio)) return fallback;
  return BigInt(limpio);
}

/**
 * Lee un parámetro numérico (no monetario: porcentajes, segundos, días).
 * Devuelve `fallback` si la clave no existe o el valor no es finito.
 */
export async function getParametroNumero(clave: string, fallback: number): Promise<number> {
  const valor = await getParametro(clave);
  if (valor === null) return fallback;
  const parsed = Number(valor.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Lee un parámetro booleano. Acepta "true"/"1" como verdadero y "false"/"0"
 * como falso (case-insensitive); cualquier otra cosa cae al `fallback`.
 */
export async function getParametroBool(clave: string, fallback: boolean): Promise<boolean> {
  const valor = await getParametro(clave);
  if (valor === null) return fallback;
  const normalizado = valor.trim().toLowerCase();
  if (normalizado === "true" || normalizado === "1") return true;
  if (normalizado === "false" || normalizado === "0") return false;
  return fallback;
}

/** Claves de umbral sembradas por `prisma/seed.ts` (reunión 1-jul-2026). */
export const CLAVES_UMBRAL = {
  desviacionPagoPct: "UMBRAL_DESVIACION_PAGO_PCT",
  saldoTramite: "UMBRAL_SALDO_TRAMITE_ALERTA",
  carteraCliente: "UMBRAL_CARTERA_CLIENTE_ALERTA",
  anticipoSoporteObligatorio: "ANTICIPO_SOPORTE_OBLIGATORIO",
  pagoComprobanteObligatorio: "PAGO_COMPROBANTE_OBLIGATORIO",
  pseTokenVigenciaSegundos: "PSE_TOKEN_VIGENCIA_SEGUNDOS",
  pseCodigoVigenciaSegundos: "PSE_CODIGO_VIGENCIA_SEGUNDOS",
} as const;

/** Defaults alineados con `prisma/seed.ts`. */
export const DEFAULTS_UMBRAL = {
  desviacionPagoPct: 10,
  saldoTramite: 200_000n,
  carteraCliente: 20_000_000n,
  anticipoSoporteObligatorio: false,
  pagoComprobanteObligatorio: false,
  pseTokenVigenciaSegundos: 1800,
  pseCodigoVigenciaSegundos: 30,
} as const;
