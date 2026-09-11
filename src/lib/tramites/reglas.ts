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

/** Solo los campos de texto de la config, ya tipados. */
export type ReglaAgenciaResuelta = {
  agencia: string | null;
  formatoDoAgencia: string | null;
  mensajeAgencia: string | null;
  mensajeFormato: string | null;
};

export function reglaAgenciaDe(config: ConfigReglaAgencia | null): ReglaAgenciaResuelta | null {
  if (!config) return null;
  const texto = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const regla = {
    agencia: texto(config.agencia),
    formatoDoAgencia: texto(config.formatoDoAgencia),
    mensajeAgencia: texto(config.mensajeAgencia),
    mensajeFormato: texto(config.mensajeFormato),
  };
  return regla.agencia || regla.formatoDoAgencia ? regla : null;
}

/**
 * Al CREAR el trámite: si la empresa tiene agencia fija, esa es la agencia
 * aunque el formulario no la mande; si manda otra, se rechaza con el mensaje
 * de la config. El formato del DO de agencia solo se valida si viene (al crear
 * puede no conocerse todavía; al avanzar el trámite sí es obligatorio).
 */
export function aplicarReglaAgenciaAlCrear(
  config: ConfigReglaAgencia | null,
  solicitada: { agenciaAduanas?: string | null; doAgencia?: string | null },
  nombreEmpresa: string,
): { ok: true; agenciaAduanas: string | null } | { ok: false; mensaje: string } {
  const regla = reglaAgenciaDe(config);
  if (!regla) return { ok: true, agenciaAduanas: solicitada.agenciaAduanas ?? null };

  const agencia = solicitada.agenciaAduanas ?? regla.agencia ?? null;
  if (regla.agencia && agencia !== regla.agencia) {
    return { ok: false, mensaje: regla.mensajeAgencia ?? `${nombreEmpresa} debe operar con ${regla.agencia}` };
  }

  if (regla.formatoDoAgencia && solicitada.doAgencia) {
    let patron: RegExp | null = null;
    try {
      patron = new RegExp(regla.formatoDoAgencia);
    } catch {
      patron = null;
    }
    if (patron && !patron.test(solicitada.doAgencia)) {
      return {
        ok: false,
        mensaje: regla.mensajeFormato ?? `${nombreEmpresa} requiere DO de agencia con formato ${regla.formatoDoAgencia}`,
      };
    }
  }

  return { ok: true, agenciaAduanas: agencia };
}
