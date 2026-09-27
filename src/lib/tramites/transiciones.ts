/**
 * Transiciones válidas del estado del DO — lógica PURA (sin BD).
 *
 * El camino de siempre es lineal:
 *   SOLICITUD → APERTURA → EN_TRAMITE → EN_PUERTO → DESPACHADO →
 *   ENVIADO_A_FACTURAR → FACTURADO → PAGADO → CERRADO
 *
 * Flujo corto (`TipoTramite.flujoCorto`, decisión de Ernesto 26-sep-2026, caso
 * OTRO: Plan Vallejo, sellos, coordinación logística): el servicio no tiene
 * operación de importación, así que desde SOLICITUD, APERTURA o EN_TRAMITE
 * también se puede saltar directo a ENVIADO_A_FACTURAR — sin pasar por
 * EN_PUERTO ni DESPACHADO. El resto del mapa (incluida la llegada a
 * FACTURADO/PAGADO/CERRADO, y las reglas de checklist/documentos/factura
 * emitida que viven en `requisitos.ts` y `factura-emitida.ts`) es igual para
 * todos los tipos de trámite: es un ATAJO, no una excepción a las demás
 * reglas.
 *
 * `lib/tramites/service.ts` (`transitionTramite`) es el único consumidor: carga
 * `tipoTramite.flujoCorto` del DO y usa esta función en vez de un mapa fijo,
 * sin ramificar por código de tipo (invariante 7 del CLAUDE.md).
 */

import type { EstadoTramite } from "@prisma/client";

const TRANSICIONES_ESTANDAR: Record<EstadoTramite, EstadoTramite[]> = {
  SOLICITUD: ["APERTURA"],
  APERTURA: ["EN_TRAMITE"],
  EN_TRAMITE: ["EN_PUERTO"],
  EN_PUERTO: ["DESPACHADO"],
  DESPACHADO: ["ENVIADO_A_FACTURAR"],
  ENVIADO_A_FACTURAR: ["FACTURADO"],
  FACTURADO: ["PAGADO"],
  PAGADO: ["CERRADO"],
  CERRADO: [],
};

/** Estados desde los que el flujo corto puede saltar directo a facturar. */
const ESTADOS_CON_ATAJO_FLUJO_CORTO: readonly EstadoTramite[] = [
  "SOLICITUD",
  "APERTURA",
  "EN_TRAMITE",
];

/**
 * A qué estados puede pasar un DO desde `estado`. `flujoCorto` (del
 * `TipoTramite` del DO) agrega el atajo directo a ENVIADO_A_FACTURAR desde
 * SOLICITUD/APERTURA/EN_TRAMITE; con `flujoCorto: false` es exactamente el
 * mapa de siempre.
 */
export function estadosSiguientes(
  estado: EstadoTramite,
  opciones: { flujoCorto: boolean },
): EstadoTramite[] {
  const siguientes = TRANSICIONES_ESTANDAR[estado];

  if (!opciones.flujoCorto || !ESTADOS_CON_ATAJO_FLUJO_CORTO.includes(estado)) {
    return siguientes;
  }

  if (siguientes.includes("ENVIADO_A_FACTURAR")) {
    return siguientes;
  }

  return [...siguientes, "ENVIADO_A_FACTURAR"];
}
