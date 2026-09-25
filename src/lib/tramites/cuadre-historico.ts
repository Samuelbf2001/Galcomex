/**
 * Marca "CUADRE DE PLATA HISTÓRICA" de los trámites históricos — reglas puras.
 *
 * La carga histórica de plata (lote HIST-PLATA-2026-09-23) dejó en cada DO
 * histórico un ítem de checklist `CUADRE DE PLATA HISTÓRICA · <COLOR>`
 * (requerido, sin marcar). Ese ítem es la única fuente de verdad de
 * "pendiente / cerrado": cerrarlo es la revisión humana del cuadre contra
 * Siigo. Por eso, a diferencia del resto del checklist:
 *   - se puede marcar en cualquier estado del DO salvo CERRADO (los
 *     históricos ya están en FACTURADO), y
 *   - solo lo cierran o reabren ADMIN y REVISOR.
 *
 * Un ítem es "de cuadre" si su descripción (normalizada a NFC) empieza por
 * el prefijo exacto Y su trámite es `esHistorico`. La descripción no se puede
 * editar desde la app (el PATCH del checklist solo toca `recibido`), y el
 * cargador, la reversa y las consultas del lote usan el mismo prefijo.
 *
 * Módulo puro (sin Prisma): lo usan el servidor y los componentes de cliente.
 */

/** Prefijo exacto de la descripción del ítem, en NFC (la "Ó" es U+00D3). */
export const PREFIJO_CUADRE_HISTORICO = "CUADRE DE PLATA HISTÓRICA";

/** Roles que pueden cerrar o reabrir el cuadre. */
export const ROLES_CUADRE_HISTORICO = ["ADMIN", "REVISOR"] as const;

const ESTADO_CERRADO = "CERRADO";

/** ¿La descripción es la del ítem de cuadre? (no mira el trámite) */
export function esItemCuadreHistorico(descripcion: string): boolean {
  return descripcion.normalize("NFC").trimStart().startsWith(PREFIJO_CUADRE_HISTORICO);
}

/** ¿Este ítem es el cuadre de plata histórica de este trámite? */
export function esCuadreHistorico(
  t: { esHistorico?: boolean | null },
  item: { descripcion: string },
): boolean {
  return t.esHistorico === true && esItemCuadreHistorico(item.descripcion);
}

function esRolCuadre(rol: string | null | undefined): boolean {
  return (ROLES_CUADRE_HISTORICO as readonly string[]).includes(rol ?? "");
}

export type PermisoItemChecklist =
  | { ok: true; cuadre: boolean }
  | { ok: false; motivo: "CERRADO" | "ROL_CUADRE" };

/**
 * Regla del servidor para marcar o desmarcar un ítem del checklist.
 *  - DO CERRADO → no (nadie modifica un trámite cerrado).
 *  - Ítem de cuadre y rol distinto de ADMIN/REVISOR → no.
 *  - El resto → sí. Los demás ítems no cambian: los marcan ADMIN, REVISOR u
 *    OPERATIVO, que es lo que ya filtra la ruta.
 */
export function permisoItemChecklist(a: {
  rol: string;
  estadoTramite: string;
  esHistorico: boolean;
  descripcion: string;
}): PermisoItemChecklist {
  if (a.estadoTramite === ESTADO_CERRADO) return { ok: false, motivo: "CERRADO" };
  const cuadre = esCuadreHistorico({ esHistorico: a.esHistorico }, { descripcion: a.descripcion });
  if (cuadre && !esRolCuadre(a.rol)) return { ok: false, motivo: "ROL_CUADRE" };
  return { ok: true, cuadre };
}

/** ¿Puede este rol cerrar o reabrir el cuadre en un DO con este estado? (lo usa la ficha) */
export function puedeCerrarCuadre(rol: string | null | undefined, estadoTramite: string): boolean {
  return esRolCuadre(rol) && estadoTramite !== ESTADO_CERRADO;
}

/** ¿El trámite tiene ítem de cuadre (pendiente o cerrado)? */
export function tieneCuadreHistorico(t: {
  esHistorico?: boolean | null;
  checklistItems?: { descripcion: string }[];
}): boolean {
  return t.esHistorico === true && (t.checklistItems ?? []).some((i) => esItemCuadreHistorico(i.descripcion));
}

/** ¿El trámite tiene el ítem de cuadre requerido y sin marcar? */
export function cuadrePendiente(t: {
  esHistorico?: boolean | null;
  checklistItems?: { descripcion: string; requerido: boolean; recibido: boolean }[];
}): boolean {
  return (
    t.esHistorico === true &&
    (t.checklistItems ?? []).some((i) => i.requerido && !i.recibido && esItemCuadreHistorico(i.descripcion))
  );
}
