/**
 * Comisión por contenedor de un DO (caso LTRANS) — lógica PURA, sin BD.
 *
 * Regla de negocio (reunión 31-ago min 84–90; Camila por WhatsApp 25-sep):
 *   - Un tercero (LTRANS) le paga a Galcomex una comisión fija por contenedor
 *     en los traslados de Polyrec ZF: hoy $90.000 por contenedor + IVA.
 *   - Polyrec trabaja con LTRANS "y con otros": en un DO de 4 contenedores
 *     puede que solo 2 sean de LTRANS. El número comisionable se escribe a mano
 *     en cada DO, nunca se deduce del total.
 *   - La carga suelta cuenta como 1 unidad (factura BAQ-18027: 12 contenedores
 *     + 3 DOs de carga suelta = 15 × 90.000 = 1.350.000 + IVA = 1.606.500).
 *
 * Dinero en BigInt (COP enteros), tolerancia 0.
 */

import type { TipoCarga } from "@prisma/client";

import { configDe, type MapaCapacidades } from "@/lib/capacidades/resolver";

export const CAPACIDAD_COMISION = "comision_por_evento" as const;

/**
 * Cuántas unidades del DO pueden llevar comisión: sus contenedores, o 1 si es
 * carga suelta. `null` = el DO todavía no tiene el número de contenedores.
 */
export function unidadesDisponibles(datos: {
  numContenedores: number | null | undefined;
  tipoCarga: TipoCarga | null | undefined;
}): number | null {
  if ((datos.numContenedores ?? 0) >= 1) return datos.numContenedores!;
  if (datos.tipoCarga === "SUELTA") return 1;
  return null;
}

/**
 * Valor por unidad de la config de `comision_por_evento` (`{ valor: "90000" }`).
 * Solo dígitos: un valor vacío, con puntos o roto cuenta como 0 (sin valor
 * configurado), nunca como un número inventado.
 */
export function valorUnitarioDe(capacidades: MapaCapacidades): bigint {
  const valor = configDe<{ valor?: unknown }>(capacidades, CAPACIDAD_COMISION)?.valor;
  if (typeof valor !== "string" || !/^\d{1,12}$/.test(valor.trim())) return 0n;
  return BigInt(valor.trim());
}

/** Concepto de venta y tipo de trámite con que se factura la comisión (B10). */
export const CONCEPTO_COMISION_DEFECTO = "COMISION_CONTENEDOR";
export const TIPO_TRAMITE_COMISION_DEFECTO = "OTRO";

export interface ConfigLiquidacionComision {
  /** Código de `concepto_venta` del «Otros» que se crea (producto Siigo y IVA salen de él). */
  conceptoVenta: string;
  /** Código de `TipoTramite` del DO que se crea: viene de la config, nunca de un `if`. */
  tipoTramite: string;
}

/**
 * Con qué se factura la comisión de una empresa: `conceptoVenta` y
 * `tipoTramite` de la config de `comision_por_evento`. Los valores de la
 * config de la empresa reemplazan a los de la de defecto; si faltan o vienen
 * rotos se usa `COMISION_CONTENEDOR` / `OTRO` (si ese concepto no existe o
 * está inactivo, `liquidarComisiones` responde 422 diciendo qué falta).
 */
export function configLiquidacionDe(capacidades: MapaCapacidades): ConfigLiquidacionComision {
  const config = configDe<{ conceptoVenta?: unknown; tipoTramite?: unknown }>(
    capacidades,
    CAPACIDAD_COMISION,
  );
  const texto = (v: unknown, defecto: string) =>
    typeof v === "string" && /^[A-Za-z0-9_]{1,60}$/.test(v.trim()) ? v.trim() : defecto;
  return {
    conceptoVenta: texto(config?.conceptoVenta, CONCEPTO_COMISION_DEFECTO),
    tipoTramite: texto(config?.tipoTramite, TIPO_TRAMITE_COMISION_DEFECTO),
  };
}

/** Texto corto de los DOs incluidos, para `referenciaExterna` del «Otros» (tope de caracteres). */
export function referenciaLiquidacion(
  filas: readonly { consecutivo: string; unidades: number }[],
  maxCaracteres = 500,
): string {
  const total = filas.reduce((s, f) => s + f.unidades, 0);
  const prefijo = `COMISIÓN POR CONTENEDOR — ${total} contenedor${total === 1 ? "" : "es"}: `;
  const partes = filas.map((f) => `${f.consecutivo} (${f.unidades})`);
  let texto = prefijo + partes.join(", ");
  if (texto.length <= maxCaracteres) return texto;
  // Recorta por el final con "y N más" sin pasar del tope.
  for (let n = partes.length - 1; n >= 0; n -= 1) {
    const resto = partes.length - n;
    texto = `${prefijo}${partes.slice(0, n).join(", ")}${n > 0 ? " " : ""}y ${resto} más`;
    if (texto.length <= maxCaracteres) return texto;
  }
  return `${prefijo}y ${partes.length} más`.slice(0, maxCaracteres);
}

/**
 * Valida las unidades comisionables de UNA empresa en el DO. `otrasUnidades` =
 * lo que ya llevan las demás empresas en el mismo DO (la suma no puede pasar
 * de los contenedores del DO). Devuelve el mensaje de error o `null`.
 */
export function errorUnidades(input: {
  unidades: number;
  disponibles: number | null;
  otrasUnidades: number;
  consecutivo: string;
}): string | null {
  if (!Number.isInteger(input.unidades) || input.unidades < 1) {
    return "Escribe cuántos contenedores llevan comisión (1 o más).";
  }
  if (input.disponibles === null) {
    return `Primero escribe el número de contenedores del ${input.consecutivo} (o márcalo como carga suelta).`;
  }
  const libres = input.disponibles - input.otrasUnidades;
  if (input.unidades > libres) {
    const detalle =
      input.otrasUnidades > 0
        ? ` (${input.disponibles} en total, ${input.otrasUnidades} ya con comisión de otra empresa)`
        : "";
    return `El ${input.consecutivo} solo tiene ${libres} contenedor${libres === 1 ? "" : "es"} disponible${libres === 1 ? "" : "s"} para comisión${detalle}.`;
  }
  return null;
}

export interface TotalesComision {
  unidades: number;
  /** Σ unidades × valor por unidad. */
  subtotal: bigint;
  /** IVA sobre el subtotal, redondeado al peso (mitad hacia arriba). */
  iva: bigint;
  total: bigint;
}

/** Totales de una lista de comisiones con su valor por unidad. */
export function totalesComision(
  filas: readonly { unidades: number; valorUnitario: bigint }[],
  tasaIva: bigint,
): TotalesComision {
  let unidades = 0;
  let subtotal = 0n;
  for (const fila of filas) {
    unidades += fila.unidades;
    subtotal += BigInt(fila.unidades) * fila.valorUnitario;
  }
  const iva = (subtotal * tasaIva + 50n) / 100n;
  return { unidades, subtotal, iva, total: subtotal + iva };
}
