import type { AgenciaAduanas } from "@prisma/client";

/**
 * Config de la capacidad `regla_agencia_fija`.
 *
 * Antes esto era `if (clienteNombre.includes("litoplas"))` — una regla de
 * negocio escrita contra el nombre de una empresa. Ahora es una capacidad con
 * config: cualquier cliente puede exigir una agencia concreta y un formato de
 * DO de agencia, y Litoplas es simplemente la primera empresa que la tiene
 * encendida (ver el backfill de la migración 20260905150000).
 */
export type ConfigReglaAgencia = {
  agencia?: unknown;
  formatoDoAgencia?: unknown;
  mensajeAgencia?: unknown;
  mensajeFormato?: unknown;
};

export function validateReglaAgenciaFija(
  tramite: {
    cliente: { nombre: string };
    agenciaAduanas: AgenciaAduanas | null;
    doAgencia: string | null;
  },
  config: ConfigReglaAgencia | null,
): string | null {
  if (!config) {
    return null;
  }

  const empresa = tramite.cliente.nombre;

  if (typeof config.agencia === "string" && tramite.agenciaAduanas !== config.agencia) {
    return typeof config.mensajeAgencia === "string"
      ? config.mensajeAgencia
      : `${empresa} debe operar con ${config.agencia}`;
  }

  if (typeof config.formatoDoAgencia === "string") {
    let patron: RegExp;
    try {
      patron = new RegExp(config.formatoDoAgencia);
    } catch {
      // Config inválida cargada a mano: no bloqueamos la operación por eso.
      return null;
    }

    if (!tramite.doAgencia || !patron.test(tramite.doAgencia)) {
      return typeof config.mensajeFormato === "string"
        ? config.mensajeFormato
        : `${empresa} requiere DO de agencia con formato ${config.formatoDoAgencia}`;
    }
  }

  return null;
}
