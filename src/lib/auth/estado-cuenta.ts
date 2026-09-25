/**
 * Reglas de la cuenta de usuario que comparten servidor y navegador: política
 * de contraseñas y los dos estados que bloquean el acceso (desactivado y clave
 * temporal). Sin imports de servidor: lo usan también los formularios.
 *
 * Detalle en CLAUDE.md, sección «Usuarios y acceso».
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const MENSAJE_PASSWORD_CORTA = `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
export const MENSAJE_PASSWORD_LARGA = `La contraseña no puede tener más de ${PASSWORD_MAX} caracteres.`;

export const CODIGO_USUARIO_DESACTIVADO = "USUARIO_DESACTIVADO";
export const MENSAJE_USUARIO_DESACTIVADO = "Usuario desactivado. Habla con el administrador.";

export const CODIGO_DEBE_CAMBIAR_PASSWORD = "DEBE_CAMBIAR_PASSWORD";
export const MENSAJE_DEBE_CAMBIAR_PASSWORD =
  "Tu contraseña es temporal: cámbiala para continuar.";

export const CODIGO_PASSWORD_REPETIDA = "PASSWORD_IGUAL_A_LA_ACTUAL";
export const MENSAJE_PASSWORD_REPETIDA = "La nueva contraseña debe ser distinta de la actual.";

/**
 * Los campos pueden faltar en la cookie de sesión emitida antes de la
 * migración `20260924100000_usuarios_admin`: por eso se compara con `false` /
 * `true` explícitos (ausente = activo y sin clave temporal).
 */
type EstadoCuenta = { activo?: boolean | null; debeCambiarPassword?: boolean | null };

export function estaDesactivado(usuario: EstadoCuenta): boolean {
  return usuario.activo === false;
}

export function tieneClaveTemporal(usuario: EstadoCuenta): boolean {
  return usuario.debeCambiarPassword === true;
}
