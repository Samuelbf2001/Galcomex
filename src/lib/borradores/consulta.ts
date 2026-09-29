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
import { anticipoDelTramite, type AnticipoDelTramite } from "@/lib/borradores/anticipo-disponible";
import { evaluarOcSinRomper, type OrdenCompraDeBorrador } from "@/lib/borradores/orden-compra-service";
import {
  ROLES_VEN_PAGOS_POR_REVISAR,
  leerPagosPorRevisar,
  type PagoPorRevisar,
} from "@/lib/borradores/pagos-por-revisar";
import { ensureBorrador, listarBorradores } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
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

type BorradorListado = Awaited<ReturnType<typeof listarBorradores>>[number];

export type BorradorConsultado = BorradorListado & {
  /**
   * Solo ADMIN y REVISOR: pagos con asesoría («NO SE COBRA») cuyo reparto con
   * lo que se cobra no es seguro, tal como quedaron al generar el borrador
   * (ver `lib/borradores/pagos-por-revisar.ts`). Ausente para el SOCIO.
   */
  pagosPorRevisar?: PagoPorRevisar[];
  /**
   * B8 (Diseño A) — solo formato CONCEPTOS_IVA: cuánto anticipo del DO está
   * asignado a esta factura, y qué le queda disponible si se re-generara
   * (excluyendo esta misma factura del "reservado"). Ausente en COMISION.
   */
  anticipoDo?: AnticipoDelTramite;
  /**
   * B4 (Diseño B) — solo CONCEPTOS_IVA con N° de orden de compra en el DO y la
   * función `orden_compra_en_revision`: si la factura cuadra con la OC (regla
   * de la empresa), los DOs hermanos de una OC compartida y la suma de sus
   * partes. Ausente en el resto (COMISION, sin OC, sin la función).
   */
  ordenCompra?: OrdenCompraDeBorrador;
};

export type BorradoresDeTramite = {
  borradores: BorradorConsultado[];
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
 *   4. Solo ADMIN/REVISOR: `pagosPorRevisar` de cada borrador (pagos con
 *      asesoría cuyo reparto hay que revisar antes de aprobar).
 */
export async function cargarBorradoresDeTramite(
  tramiteId: string,
  usuario: UsuarioConsulta,
): Promise<BorradoresDeTramite> {
  const borradores = await listarBorradoresConPermiso(tramiteId, usuario);
  const conAnticipo = await conOrdenCompra(await conAnticipoDo(borradores));

  if (!ROLES_VEN_PAGOS_POR_REVISAR.includes(usuario.rol)) {
    return { borradores: conAnticipo };
  }

  const porRevisar = await leerPagosPorRevisarSinRomper(
    borradores.map((b) => b.id),
    `del trámite ${tramiteId}`,
  );
  return { borradores: conPagosPorRevisar(conAnticipo, porRevisar) };
}

/**
 * B8 — añade `anticipoDo` a cada borrador CONCEPTOS_IVA del trámite (excluye
 * el propio borrador de "lo reservado por otras", igual que al aprobar).
 */
async function conAnticipoDo(borradores: BorradorListado[]): Promise<BorradorConsultado[]> {
  return Promise.all(
    borradores.map(async (b): Promise<BorradorConsultado> => {
      if (b.formatoFactura !== "CONCEPTOS_IVA") return b;
      const anticipoDo = await anticipoDelTramite(prisma, b.tramiteId, { excluirBorradorId: b.id });
      return { ...b, anticipoDo };
    }),
  );
}

/**
 * B4 — añade `ordenCompra` a los borradores CONCEPTOS_IVA cuyo DO tiene N° de
 * OC. Una sola consulta decide qué DOs la tienen (la gran mayoría no), y solo
 * a esos se les evalúa la OC.
 */
async function conOrdenCompra<T extends BorradorListado>(borradores: T[]): Promise<Array<T & { ordenCompra?: OrdenCompraDeBorrador }>> {
  const candidatos = borradores.filter((b) => b.formatoFactura === "CONCEPTOS_IVA");
  if (candidatos.length === 0) return borradores;

  const conOc = await prisma.tramiteDO.findMany({
    where: { id: { in: [...new Set(candidatos.map((b) => b.tramiteId))] }, ordenCompraNumero: { not: null } },
    select: { id: true },
  });
  const idsConOc = new Set(conOc.map((t) => t.id));
  if (idsConOc.size === 0) return borradores;

  return Promise.all(
    borradores.map(async (b) => {
      if (b.formatoFactura !== "CONCEPTOS_IVA" || !idsConOc.has(b.tramiteId)) return b;
      const ordenCompra = await evaluarOcSinRomper(prisma, b.id);
      return ordenCompra ? { ...b, ordenCompra } : b;
    }),
  );
}

/** Pasos 1 a 3 de `cargarBorradoresDeTramite` (permiso, red de seguridad, listado). */
async function listarBorradoresConPermiso(
  tramiteId: string,
  usuario: UsuarioConsulta,
): Promise<BorradorListado[]> {
  const permiso = await resolverTramiteConPermiso(tramiteId, usuario.rol);
  if (permiso === null) {
    throw new TramiteNoEncontradoError();
  }
  if (permiso === "forbidden") {
    throw new TramiteNoAutorizadoError();
  }

  await ensureBorrador(tramiteId, usuario.id);

  return listarBorradores(tramiteId);
}

/**
 * `leerPagosPorRevisar` sin tumbar la consulta: el aviso es de apoyo, así que
 * si no se puede leer, el revisor igual ve sus borradores (`null` → sin el
 * campo, que la UI trata como «sin aviso»).
 */
async function leerPagosPorRevisarSinRomper(
  borradorIds: readonly string[],
  contexto: string,
): Promise<Map<string, PagoPorRevisar[]> | null> {
  try {
    return await leerPagosPorRevisar(borradorIds);
  } catch (error) {
    console.error(
      `[borradores/consulta] no se pudieron leer los pagos por revisar ${contexto}`,
      error,
    );
    return null;
  }
}

/**
 * Borrador recién generado (respuesta de POST /api/tramites/[id]/borrador)
 * con sus pagos por revisar, igual que los devuelve el GET: así el revisor
 * que se abre al generarlo ya muestra el aviso. Solo ADMIN/REVISOR; si no se
 * pueden leer, sale sin el campo (la UI lo trata como «no se sabe»).
 */
export async function conPagosPorRevisarDeBorrador<T extends { id: string }>(
  borrador: T,
  rol: string,
): Promise<T & { pagosPorRevisar?: PagoPorRevisar[] }> {
  if (!ROLES_VEN_PAGOS_POR_REVISAR.includes(rol)) return borrador;
  const porRevisar = await leerPagosPorRevisarSinRomper(
    [borrador.id],
    `del borrador ${borrador.id}`,
  );
  if (porRevisar === null) return borrador;
  return { ...borrador, pagosPorRevisar: porRevisar.get(borrador.id) ?? [] };
}

function conPagosPorRevisar(
  borradores: BorradorConsultado[],
  porRevisar: Map<string, PagoPorRevisar[]> | null,
): BorradorConsultado[] {
  if (porRevisar === null) return borradores;
  return borradores.map((b) => ({ ...b, pagosPorRevisar: porRevisar.get(b.id) ?? [] }));
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
 * misma lógica que el endpoint individual (`cargarBorradoresDeTramite`, con
 * el mismo resultado por trámite); si un trámite falla (no encontrado, sin
 * permiso, error) su entrada lleva `{ error }` y el resto sigue. Se resuelven
 * en grupos de `tamanoGrupo` con `Promise.all` para no abrir N conexiones a
 * la vez. El paso 4 (pagos por revisar, solo ADMIN/REVISOR) va al final en
 * UNA sola consulta para todos los borradores del lote, no una por trámite.
 */
export async function cargarBorradoresEnLote(
  tramiteIds: readonly string[],
  usuario: UsuarioConsulta,
  tamanoGrupo = TAMANO_GRUPO_LOTE,
): Promise<Record<string, ResultadoBorradoresLote>> {
  const listados: Array<[string, BorradorListado[] | { error: string }]> = [];

  for (let inicio = 0; inicio < tramiteIds.length; inicio += tamanoGrupo) {
    const grupo = tramiteIds.slice(inicio, inicio + tamanoGrupo);

    const resultados = await Promise.all(
      grupo.map(async (tramiteId): Promise<[string, BorradorListado[] | { error: string }]> => {
        try {
          return [tramiteId, await listarBorradoresConPermiso(tramiteId, usuario)];
        } catch (error) {
          return [tramiteId, { error: mensajeDeError(tramiteId, error) }];
        }
      }),
    );

    listados.push(...resultados);
  }

  let porRevisar: Map<string, PagoPorRevisar[]> | null = null;
  if (ROLES_VEN_PAGOS_POR_REVISAR.includes(usuario.rol)) {
    const borradorIds = listados.flatMap(([, r]) => (Array.isArray(r) ? r.map((b) => b.id) : []));
    porRevisar =
      borradorIds.length === 0
        ? new Map()
        : await leerPagosPorRevisarSinRomper(borradorIds, "del lote");
  }

  // B4 — la orden de compra de todo el lote en una pasada (una consulta decide qué DOs la tienen).
  const conOc = await conOrdenCompra(listados.flatMap(([, r]) => (Array.isArray(r) ? r : [])));
  const ocPorBorrador = new Map(conOc.flatMap((b) => (b.ordenCompra ? [[b.id, b.ordenCompra] as const] : [])));

  const porTramite: Record<string, ResultadoBorradoresLote> = {};
  for (const [tramiteId, resultado] of listados) {
    porTramite[tramiteId] = Array.isArray(resultado)
      ? {
          borradores: conPagosPorRevisar(
            resultado.map((b) => (ocPorBorrador.has(b.id) ? { ...b, ordenCompra: ocPorBorrador.get(b.id) } : b)),
            porRevisar,
          ),
        }
      : resultado;
  }

  return porTramite;
}
