/**
 * Reglas de edición de usuarios por el ADMIN — funciones PURAS, sin BD.
 * El servicio las aplica dentro de la transacción, con las filas de los ADMIN
 * activos bloqueadas (`FOR UPDATE`), para que dos cambios simultáneos no
 * puedan dejar el sistema sin administrador.
 */

import type { Rol } from "@/lib/auth/auth";

export class ReglaUsuarioError extends Error {
  public readonly status = 422;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ReglaUsuarioError";
  }
}

export const MENSAJE_AUTO_DESACTIVAR = "No puedes desactivar tu propio usuario.";
export const MENSAJE_AUTO_QUITAR_ADMIN = "No puedes quitarte tu propio rol de administrador.";
export const MENSAJE_ULTIMO_ADMIN =
  "Debe quedar al menos un administrador activo. Asigna el rol de administrador a otra persona antes de hacer este cambio.";

export type EstadoUsuario = { id: string; rol: Rol; activo: boolean };
export type CambiosUsuario = { name?: string; rol?: Rol; activo?: boolean };

function esAdminActivo(rol: Rol, activo: boolean): boolean {
  return rol === "ADMIN" && activo;
}

/**
 * Lanza `ReglaUsuarioError` si el cambio no se puede hacer:
 * 1. Un ADMIN no se desactiva a sí mismo.
 * 2. Un ADMIN no se quita a sí mismo el rol ADMIN.
 * 3. Nunca queda el sistema sin ningún ADMIN activo (ni por cambio de rol ni
 *    por desactivación).
 *
 * `adminsActivosIds` son los ADMIN activos ANTES del cambio (incluido el
 * objetivo si lo es).
 */
export function validarCambioUsuario(params: {
  objetivo: EstadoUsuario;
  cambios: CambiosUsuario;
  actorId: string;
  adminsActivosIds: readonly string[];
}): void {
  const { objetivo, cambios, actorId, adminsActivosIds } = params;
  const rolFinal = cambios.rol ?? objetivo.rol;
  const activoFinal = cambios.activo ?? objetivo.activo;

  if (objetivo.id === actorId) {
    if (objetivo.activo && activoFinal === false) {
      throw new ReglaUsuarioError(MENSAJE_AUTO_DESACTIVAR);
    }
    if (objetivo.rol === "ADMIN" && rolFinal !== "ADMIN") {
      throw new ReglaUsuarioError(MENSAJE_AUTO_QUITAR_ADMIN);
    }
  }

  const eraAdminActivo = esAdminActivo(objetivo.rol, objetivo.activo);
  const seraAdminActivo = esAdminActivo(rolFinal, activoFinal);
  if (eraAdminActivo && !seraAdminActivo) {
    const restantes = adminsActivosIds.filter((id) => id !== objetivo.id);
    if (restantes.length === 0) {
      throw new ReglaUsuarioError(MENSAJE_ULTIMO_ADMIN);
    }
  }
}
