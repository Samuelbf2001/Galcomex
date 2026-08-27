/**
 * Umbrales de alerta — Galcomex
 * A3-T?: Alertas de saldo de trámite y cartera (reunión 1-jul con el cliente).
 *
 * Lee la tabla Parametro para las 3 claves nuevas de umbral:
 *   UMBRAL_ALERTA_SALDO_TRAMITE_PROPIO = "500000"    (COP, trámites cliente PROPIO)
 *   UMBRAL_ALERTA_SALDO_TRAMITE_SOCIO  = "200000"    (COP, trámites cliente SOCIO_LM)
 *   UMBRAL_ALERTA_CARTERA_CLIENTE      = "-20000000" (COP, saldo neto de cartera por cliente)
 *
 * A diferencia de src/lib/parametros/service.ts (que lanza si falta una clave
 * obligatoria para el cálculo de factura), estos umbrales son de alerta —no
 * bloquean flujo alguno—, así que ante un valor ausente o inválido en BD se
 * usa el default sembrado en prisma/seed.ts en vez de romper la vista.
 */

import { prisma } from "@/lib/db/prisma";

const CLAVE_UMBRAL_TRAMITE_PROPIO = "UMBRAL_ALERTA_SALDO_TRAMITE_PROPIO";
const CLAVE_UMBRAL_TRAMITE_SOCIO = "UMBRAL_ALERTA_SALDO_TRAMITE_SOCIO";
const CLAVE_UMBRAL_CARTERA_CLIENTE = "UMBRAL_ALERTA_CARTERA_CLIENTE";

const DEFAULT_UMBRAL_TRAMITE_PROPIO = 500_000n;
const DEFAULT_UMBRAL_TRAMITE_SOCIO = 200_000n;
const DEFAULT_UMBRAL_CARTERA_CLIENTE = -20_000_000n;

export type UmbralesAlertaTramite = {
  /** Umbral aplicable a trámites de clientes tipo PROPIO. */
  propio: bigint;
  /** Umbral aplicable a trámites de clientes tipo SOCIO_LM. */
  socio: bigint;
};

function parseBigIntParametro(valor: string | undefined, fallback: bigint): bigint {
  if (valor === undefined) return fallback;
  try {
    return BigInt(valor);
  } catch {
    return fallback;
  }
}

/** Lee los umbrales de alerta de saldo de trámite (propio / socio) desde Parametro. */
export async function getUmbralesAlertaTramite(): Promise<UmbralesAlertaTramite> {
  const rows = await prisma.parametro.findMany({
    where: { clave: { in: [CLAVE_UMBRAL_TRAMITE_PROPIO, CLAVE_UMBRAL_TRAMITE_SOCIO] } },
    select: { clave: true, valor: true },
  });

  const map = new Map<string, string>(rows.map((r) => [r.clave, r.valor]));

  return {
    propio: parseBigIntParametro(map.get(CLAVE_UMBRAL_TRAMITE_PROPIO), DEFAULT_UMBRAL_TRAMITE_PROPIO),
    socio: parseBigIntParametro(map.get(CLAVE_UMBRAL_TRAMITE_SOCIO), DEFAULT_UMBRAL_TRAMITE_SOCIO),
  };
}

/**
 * Umbral aplicable a un trámite según el tipo de cliente del DO.
 * SOCIO_LM → umbral socio; PROPIO (o cualquier otro valor) → umbral propio.
 */
export function umbralPorTipoCliente(
  tipoCliente: string | null | undefined,
  umbrales: UmbralesAlertaTramite,
): bigint {
  return tipoCliente === "SOCIO_LM" ? umbrales.socio : umbrales.propio;
}

/** Lee el umbral de alerta de cartera por cliente desde Parametro. */
export async function getUmbralAlertaCarteraCliente(): Promise<bigint> {
  const row = await prisma.parametro.findUnique({
    where: { clave: CLAVE_UMBRAL_CARTERA_CLIENTE },
    select: { valor: true },
  });
  return parseBigIntParametro(row?.valor, DEFAULT_UMBRAL_CARTERA_CLIENTE);
}
