import type { Rol } from "@/lib/auth/auth";

/**
 * «Probar como otro rol» (solo la administradora). Reglas puras, sin imports
 * de servidor: las usan `session.ts`, la ruta `/api/usuarios/rol-simulado` y
 * los componentes cliente (franja y selector).
 *
 * La administradora conserva su identidad (lo que haga queda a su nombre) pero
 * mientras dura la simulación TODA la plataforma la trata como el rol elegido.
 * Solo puede BAJAR permisos: los roles simulables no incluyen ADMIN.
 */

export const COOKIE_ROL_SIMULADO = "galcomex_rol_simulado";

export const ROLES_SIMULABLES = ["REVISOR", "OPERATIVO", "SOCIO"] as const;

export type RolSimulable = (typeof ROLES_SIMULABLES)[number];

/** La simulación se olvida sola a las 4 horas (por si se queda abierta). */
export const DURACION_SIMULACION_SEG = 4 * 60 * 60;

/** Nombre de la persona real detrás de cada rol, para que la administradora sepa a quién «es». */
export const ETIQUETA_ROL_SIMULABLE: Record<RolSimulable, string> = {
  REVISOR: "Revisor (Guillermo)",
  OPERATIVO: "Operativo (Karina)",
  SOCIO: "Socio (Lucho)",
};

/** ¿Es un rol que se puede probar? (ADMIN y cualquier otro valor: no). */
export function esRolSimulable(valor: unknown): valor is RolSimulable {
  return typeof valor === "string" && (ROLES_SIMULABLES as readonly string[]).includes(valor);
}

/**
 * Rol con el que se trata a la sesión.
 *
 * Solo si el rol REAL es ADMIN y la cookie trae uno de los tres roles
 * simulables se sustituye. Un no-admin con la cookie NO cambia nada (nunca
 * sube ni cambia de rol), y un valor como "ADMIN" o cualquier texto raro en la
 * cookie se ignora.
 */
export function resolverRolEfectivo(
  rolReal: string,
  valorCookie: string | undefined,
): { rol: Rol; simulado: RolSimulable | null } {
  if (rolReal === "ADMIN" && esRolSimulable(valorCookie)) {
    return { rol: valorCookie, simulado: valorCookie };
  }
  return { rol: rolReal as Rol, simulado: null };
}

/**
 * Valor de una cookie a partir de la cabecera `Cookie` de la petición
 * (`undefined` si falta). Se lee de la cabecera, igual que Better Auth lee la
 * sesión, para no depender de otra API dinámica de Next.
 */
export function leerCookie(cabeceraCookie: string | null | undefined, nombre: string): string | undefined {
  if (!cabeceraCookie) return undefined;
  for (const par of cabeceraCookie.split(";")) {
    const i = par.indexOf("=");
    if (i < 0) continue;
    if (par.slice(0, i).trim() !== nombre) continue;
    const crudo = par.slice(i + 1).trim();
    try {
      return decodeURIComponent(crudo);
    } catch {
      return crudo;
    }
  }
  return undefined;
}
