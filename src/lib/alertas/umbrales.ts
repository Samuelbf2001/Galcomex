/**
 * Umbrales de alerta — Galcomex
 * A3-T?: Alertas de saldo de trámite y cartera (reunión 1-jul con el cliente).
 *
 * Lee la tabla Parametro para las 3 claves nuevas de umbral:
 *   UMBRAL_ALERTA_SALDO_TRAMITE_PROPIO = "500000"    (COP, trámites cliente PROPIO)
 *   UMBRAL_ALERTA_SALDO_TRAMITE_SOCIO  = "200000"    (COP, trámites cliente SOCIO_LM)
 *   UMBRAL_ALERTA_CARTERA_CLIENTE      = "-20000000" (COP, saldo neto de cartera por cliente)
 *
 * Fase centavos (B.2/B.3): el `Parametro` y la config de la capacidad
 * `umbral_saldo_tramite` guardan PESOS en texto ("500000", "500000.50" o, si
 * alguien lo escribió a mano, "500000.00"); se leen con `centavosDeTexto` y el
 * resultado es CENTAVOS (`bigint`), la unidad de los saldos con que se compara.
 *
 * A diferencia de src/lib/parametros/service.ts (que lanza si falta una clave
 * obligatoria para el cálculo de factura), estos umbrales son de alerta —no
 * bloquean flujo alguno—, así que ante un valor ausente o inválido en BD se
 * usa el default sembrado en prisma/seed.ts en vez de romper la vista. Un valor
 * ilegible ya no cae en silencio: deja un aviso en el log con la clave.
 */

import { configDe, type MapaCapacidades } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import { centavosDeTexto, pesos } from "@/lib/dinero";

const CLAVE_UMBRAL_TRAMITE_PROPIO = "UMBRAL_ALERTA_SALDO_TRAMITE_PROPIO";
const CLAVE_UMBRAL_TRAMITE_SOCIO = "UMBRAL_ALERTA_SALDO_TRAMITE_SOCIO";
const CLAVE_UMBRAL_CARTERA_CLIENTE = "UMBRAL_ALERTA_CARTERA_CLIENTE";

const DEFAULT_UMBRAL_TRAMITE_PROPIO = pesos(500_000);
const DEFAULT_UMBRAL_TRAMITE_SOCIO = pesos(200_000);
const DEFAULT_UMBRAL_CARTERA_CLIENTE = pesos(-20_000_000);

export type UmbralesAlertaTramite = {
  /** Umbral aplicable a trámites de clientes tipo PROPIO (centavos). */
  propio: bigint;
  /** Umbral aplicable a trámites de clientes tipo SOCIO_LM (centavos). */
  socio: bigint;
};

/**
 * Pesos en texto (Parametro / config) → centavos. Ausente → defecto sin aviso;
 * ilegible ("150.000", "1e5", "") → aviso con la clave y defecto.
 */
export function umbralDeTexto(valor: string | undefined, fallback: bigint, clave: string): bigint {
  if (valor === undefined) return fallback;
  try {
    return centavosDeTexto(valor.trim());
  } catch {
    console.warn(`[alertas] valor ilegible en ${clave} ("${valor}"): se usa el valor por defecto`);
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
    propio: umbralDeTexto(map.get(CLAVE_UMBRAL_TRAMITE_PROPIO), DEFAULT_UMBRAL_TRAMITE_PROPIO, CLAVE_UMBRAL_TRAMITE_PROPIO),
    socio: umbralDeTexto(map.get(CLAVE_UMBRAL_TRAMITE_SOCIO), DEFAULT_UMBRAL_TRAMITE_SOCIO, CLAVE_UMBRAL_TRAMITE_SOCIO),
  };
}

/**
 * Umbral aplicable a un trámite según el tipo de cliente del DO.
 * SOCIO_LM → umbral socio; PROPIO (o cualquier otro valor) → umbral propio.
 *
 * Es el fallback global: la empresa puede sobrescribirlo con la capacidad
 * `umbral_saldo_tramite` (ver `umbralParaEmpresa`).
 */
export function umbralPorTipoCliente(
  tipoCliente: string | null | undefined,
  umbrales: UmbralesAlertaTramite,
): bigint {
  return tipoCliente === "SOCIO_LM" ? umbrales.socio : umbrales.propio;
}

/**
 * Umbral efectivo de un trámite (primer consumidor de las capacidades, M1), en
 * centavos.
 *
 * Cascada: capacidad `umbral_saldo_tramite` de la empresa → parámetro global
 * por tipo de cliente. Mientras ninguna empresa encienda la capacidad, el
 * resultado es idéntico al de `umbralPorTipoCliente`, que es justo lo que se
 * quiere de una migración a capacidades: cambia de dónde sale el dato, no el
 * comportamiento. La config guarda pesos en texto (`{ valor: "500000" }`); un
 * número entero también se acepta como pesos.
 */
export function umbralParaEmpresa(
  capacidades: MapaCapacidades,
  tipoCliente: string | null | undefined,
  umbrales: UmbralesAlertaTramite,
): bigint {
  const config = configDe<{ valor?: unknown }>(capacidades, "umbral_saldo_tramite");
  const valor = config?.valor;
  const porDefecto = umbralPorTipoCliente(tipoCliente, umbrales);

  if (typeof valor === "string") {
    return umbralDeTexto(valor, porDefecto, "capacidad umbral_saldo_tramite");
  }
  if (typeof valor === "number") {
    if (Number.isSafeInteger(valor)) return pesos(valor);
    console.warn(`[alertas] valor ilegible en capacidad umbral_saldo_tramite (${valor}): se usa el valor por defecto`);
  }

  return porDefecto;
}

/** Lee el umbral de alerta de cartera por cliente desde Parametro (centavos). */
export async function getUmbralAlertaCarteraCliente(): Promise<bigint> {
  const row = await prisma.parametro.findUnique({
    where: { clave: CLAVE_UMBRAL_CARTERA_CLIENTE },
    select: { valor: true },
  });
  return umbralDeTexto(row?.valor, DEFAULT_UMBRAL_CARTERA_CLIENTE, CLAVE_UMBRAL_CARTERA_CLIENTE);
}
