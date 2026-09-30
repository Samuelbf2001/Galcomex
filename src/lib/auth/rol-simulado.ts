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

/** Nombre de la cookie fuera de producción (desarrollo, pruebas). */
export const COOKIE_ROL_SIMULADO = "galcomex_rol_simulado";

/** Nombre de la cookie en producción: con el prefijo `__Host-`. */
export const COOKIE_ROL_SIMULADO_PRODUCCION = `__Host-${COOKIE_ROL_SIMULADO}`;

/**
 * ÚNICO lugar que decide cómo se llama la cookie: la leen `session.ts` y la
 * escriben/borran la ruta de «Probar como» y el login.
 *
 * En producción lleva el prefijo `__Host-`: el navegador solo la acepta si la
 * puso el propio sitio con `Secure`, `path=/` y SIN `Domain`. Así ningún otro
 * subdominio de sixteam.pro (hay ~12 proyectos de clientes colgando de él)
 * puede plantar una cookie con ese nombre para colarse en la sesión. Fuera de
 * producción (http://localhost, sin `Secure`) el prefijo se rechazaría, por
 * eso allí sigue el nombre simple. Se lee `NODE_ENV` en cada llamada, no al
 * cargar el módulo, para que las pruebas puedan cambiarlo.
 */
export function nombreCookieRolSimulado(): string {
  return process.env.NODE_ENV === "production"
    ? COOKIE_ROL_SIMULADO_PRODUCCION
    : COOKIE_ROL_SIMULADO;
}

/**
 * Atributos de la cookie: solo el servidor la lee (`httpOnly`), no viaja a
 * otros sitios (`lax`) y en producción exige HTTPS (`secure`, requisito del
 * prefijo `__Host-`). Sin `domain` a propósito.
 */
export function opcionesCookieRolSimulado() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

/**
 * Valor de la cookie: `ROL.userId` (p. ej. `OPERATIVO.cmxxx`). Va atado a la
 * persona para que otra administradora que entre en el mismo navegador no
 * herede la simulación de la anterior.
 */
export function valorCookieRolSimulado(rol: RolSimulable, userId: string): string {
  return `${rol}.${userId}`;
}

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
 * Rol simulado que trae el valor de la cookie (`ROL.userId`) para ESTE usuario,
 * o `null` si el formato no es exactamente ese, el rol no es simulable o el
 * `userId` no coincide con el de la sesión.
 */
function rolDeValorCookie(valor: string | undefined, userId: string): RolSimulable | null {
  if (!valor || !userId) return null;
  const punto = valor.indexOf(".");
  if (punto < 0) return null;
  const rol = valor.slice(0, punto);
  const id = valor.slice(punto + 1);
  return id === userId && esRolSimulable(rol) ? rol : null;
}

/**
 * Rol con el que se trata a la sesión.
 *
 * Solo se sustituye si se cumplen las tres a la vez: el rol REAL es ADMIN, la
 * cookie trae `ROL.userId` con uno de los tres roles simulables y ese `userId`
 * es exactamente el de la sesión. Un no-admin con la cookie NO cambia nada
 * (nunca sube ni cambia de rol); un valor como "ADMIN", el formato viejo sin
 * `userId`, la cookie de otra persona o cualquier texto raro se ignora.
 */
export function resolverRolEfectivo(
  rolReal: string,
  valorCookie: string | undefined,
  userId: string,
): { rol: Rol; simulado: RolSimulable | null } {
  if (rolReal === "ADMIN") {
    const simulado = rolDeValorCookie(valorCookie, userId);
    if (simulado) return { rol: simulado, simulado };
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
