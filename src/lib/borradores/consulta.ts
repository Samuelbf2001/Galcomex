/**
 * Consulta de borradores por trámite con el gate de permisos del rol.
 *
 * Lógica COMPARTIDA entre:
 *   - GET /api/tramites/[id]/borrador        (un trámite)
 *   - GET /api/facturacion/borradores        (lote, hasta 100 trámites)
 *
 * Cualquier cambio de comportamiento (scope del SOCIO, red de seguridad
 * ensureBorrador, orden del listado) se hace aquí una sola vez y aplica a
 * ambos endpoints por igual.
 */

import type { Rol } from "@/lib/auth/auth";
import { resolverTramiteConPermiso } from "@/lib/auth/tramite-acceso";
import { ensureBorrador, listarBorradores } from "@/lib/borradores/service";
import { isDomainError } from "@/lib/http/errors";

/** Roles que pueden consultar borradores (individual y lote). */
export const ROLES_CONSULTA_BORRADORES: readonly Rol[] = ["ADMIN", "REVISOR", "SOCIO"];

/** Tamaño de los grupos en que se resuelven los trámites del lote. */
export const TAMANO_GRUPO_LOTE = 10;

// ─── Errores tipados (mismos mensajes/status que el endpoint individual) ─────

export class TramiteNoEncontradoError extends Error {
  public readonly status = 404;
  constructor() {
    super("Trámite no encontrado");
    this.name = "TramiteNoEncontradoError";
  }
}

export class TramiteNoAutorizadoError extends Error {
  public readonly status = 403;
  constructor() {
    super("No autorizado");
    this.name = "TramiteNoAutorizadoError";
  }
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type UsuarioConsulta = {
  id: string;
  rol: string;
};

export type BorradoresDeTramite = {
  borradores: Awaited<ReturnType<typeof listarBorradores>>;
};

export type ResultadoBorradoresLote = BorradoresDeTramite | { error: string };

// ─── Consulta individual ──────────────────────────────────────────────────────

/**
 * Carga los borradores de un trámite aplicando, en este orden:
 *   1. resolverTramiteConPermiso → 404 si no existe, 403 si el SOCIO no
 *      tiene acceso (solo clientes SOCIO_LM).
 *   2. ensureBorrador → red de seguridad idempotente: si el trámite está en
 *      ENVIADO_A_FACTURAR sin borrador, lo crea. Aplica a PROPIO y SOCIO_LM.
 *   3. listarBorradores → del más reciente al más antiguo.
 */
export async function cargarBorradoresDeTramite(
  tramiteId: string,
  usuario: UsuarioConsulta,
): Promise<BorradoresDeTramite> {
  const permiso = await resolverTramiteConPermiso(tramiteId, usuario.rol);
  if (permiso === null) {
    throw new TramiteNoEncontradoError();
  }
  if (permiso === "forbidden") {
    throw new TramiteNoAutorizadoError();
  }

  await ensureBorrador(tramiteId, usuario.id);

  const borradores = await listarBorradores(tramiteId);

  return { borradores };
}

// ─── Consulta por lote ────────────────────────────────────────────────────────

function mensajeDeError(tramiteId: string, error: unknown): string {
  if (isDomainError(error)) {
    return error.message;
  }

  // Error inesperado (BD, motor): no se filtra el detalle al cliente.
  console.error(`[borradores/lote] error cargando borradores del trámite ${tramiteId}`, error);
  return "Error al cargar los borradores del trámite";
}

/**
 * Carga los borradores de varios trámites. Cada id pasa por EXACTAMENTE la
 * misma lógica que el endpoint individual (`cargarBorradoresDeTramite`);
 * si un trámite falla (no encontrado, sin permiso, error) su entrada lleva
 * `{ error }` y el resto sigue. Se resuelven en grupos de `tamanoGrupo` con
 * `Promise.all` para no abrir N conexiones a la vez.
 */
export async function cargarBorradoresEnLote(
  tramiteIds: readonly string[],
  usuario: UsuarioConsulta,
  tamanoGrupo = TAMANO_GRUPO_LOTE,
): Promise<Record<string, ResultadoBorradoresLote>> {
  const porTramite: Record<string, ResultadoBorradoresLote> = {};

  for (let inicio = 0; inicio < tramiteIds.length; inicio += tamanoGrupo) {
    const grupo = tramiteIds.slice(inicio, inicio + tamanoGrupo);

    const resultados = await Promise.all(
      grupo.map(async (tramiteId): Promise<[string, ResultadoBorradoresLote]> => {
        try {
          return [tramiteId, await cargarBorradoresDeTramite(tramiteId, usuario)];
        } catch (error) {
          return [tramiteId, { error: mensajeDeError(tramiteId, error) }];
        }
      }),
    );

    for (const [tramiteId, resultado] of resultados) {
      porTramite[tramiteId] = resultado;
    }
  }

  return porTramite;
}
