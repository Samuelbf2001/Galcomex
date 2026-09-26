/**
 * Marcar o desmarcar un ítem del checklist del trámite — Galcomex.
 *
 * Único punto de escritura de `ChecklistItem.recibido` desde la app
 * (`PATCH /api/tramites/[id]/checklist/[itemId]`). En una sola transacción:
 * valida que el trámite no esté CERRADO, aplica la regla del ítem de cuadre
 * de plata histórica (solo ADMIN/REVISOR, ver `cuadre-historico.ts`) y deja
 * un AuditLog `UPDATE_CHECKLIST_ITEM` con antes y después para TODOS los
 * ítems (invariante 5). Marcar el mismo valor que ya tiene no escribe nada.
 *
 * Aquí vive también el candado del cuadre para las demás escrituras del
 * checklist (`cuadresHistoricosAbiertos` / `assertCuadreSigueAbierto`).
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { esCuadreHistorico, permisoItemChecklist } from "@/lib/tramites/cuadre-historico";
import { assertTramiteModificable } from "@/lib/tramites/guard";

export class ChecklistItemNoEncontradoError extends Error {
  public readonly status = 404;
  constructor() {
    super("Ítem de checklist no encontrado");
    this.name = "ChecklistItemNoEncontradoError";
  }
}

export class CuadreHistoricoRolError extends Error {
  public readonly status = 403;
  constructor() {
    super("Solo ADMIN o REVISOR pueden cerrar o reabrir el cuadre de plata histórica");
    this.name = "CuadreHistoricoRolError";
  }
}

/** Una subida de documento intentó cerrar el cuadre de plata histórica. */
export class CuadreHistoricoDocumentoError extends Error {
  public readonly status = 403;
  constructor() {
    super(
      "El cuadre de plata histórica no se cierra subiendo un archivo: lo cierran ADMIN o REVISOR con su casilla en la ficha del DO.",
    );
    this.name = "CuadreHistoricoDocumentoError";
  }
}

// ─── Candado del cuadre fuera del PATCH del checklist ─────────────────────────
//
// El cuadre de plata histórica solo se cierra con `actualizarItemChecklist`
// (ADMIN/REVISOR, con AuditLog UPDATE_CHECKLIST_ITEM). Las demás escrituras que
// tocan el checklist dentro de su propia transacción (hoy: registrarDocumento)
// toman este candado al empezar y lo comprueban al final, antes del commit:
//
//   const abiertos = await cuadresHistoricosAbiertos(tx, tramite);
//   …escrituras…
//   await assertCuadreSigueAbierto(tx, abiertos, usuarioId);
//
// No depende de CÓMO se marque el ítem. Por eso cubre también caminos que se
// agreguen después sin mirar el cuadre: la rama feat/eventos-subir-archivos
// (934bbdf) añade a registrarDocumento un `if (requisito)` que marca el ítem
// que llega en `checklistItemId` sin mirar rol ni cuadre, y se mezcla con D0
// sin conflicto. Con el candado, esa subida falla con 403 y no escribe nada.

/** Ids de los ítems de cuadre del DO que siguen abiertos (vacío si el DO no es histórico). */
export async function cuadresHistoricosAbiertos(
  tx: Prisma.TransactionClient,
  tramite: { id: string; esHistorico: boolean },
): Promise<string[]> {
  if (!tramite.esHistorico) return [];
  const abiertos = await tx.checklistItem.findMany({
    where: { tramiteId: tramite.id, recibido: false },
    select: { id: true, descripcion: true },
  });
  return abiertos.filter((item) => esCuadreHistorico(tramite, item)).map((item) => item.id);
}

/**
 * Lanza `CuadreHistoricoDocumentoError` (403, la transacción se deshace) si
 * alguno de los cuadres que estaban abiertos quedó cerrado a nombre de
 * `usuarioId` dentro de esta transacción.
 */
export async function assertCuadreSigueAbierto(
  tx: Prisma.TransactionClient,
  abiertos: readonly string[],
  usuarioId: string,
): Promise<void> {
  if (abiertos.length === 0) return;
  // Solo cuenta lo cerrado a nombre de este usuario: si un ADMIN/REVISOR
  // cierra el cuadre con la casilla mientras otra persona sube un archivo
  // (READ COMMITTED deja ver ese commit), la subida no debe fallar.
  const cerrados = await tx.checklistItem.count({
    where: { id: { in: [...abiertos] }, recibido: true, validadoPorId: usuarioId },
  });
  if (cerrados > 0) throw new CuadreHistoricoDocumentoError();
}

export type ActualizarItemChecklistInput = {
  tramiteId: string;
  itemId: string;
  recibido: boolean;
  usuarioId: string;
  rol: string;
};

function snapshot(item: {
  descripcion: string;
  recibido: boolean;
  validadoPorId: string | null;
  fechaValidacion: Date | null;
}) {
  return {
    descripcion: item.descripcion,
    recibido: item.recibido,
    validadoPorId: item.validadoPorId,
    fechaValidacion: item.fechaValidacion ? item.fechaValidacion.toISOString() : null,
  };
}

export async function actualizarItemChecklist(input: ActualizarItemChecklistInput) {
  const { tramiteId, itemId, recibido, usuarioId, rol } = input;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const item = await tx.checklistItem.findFirst({
      where: { id: itemId, tramiteId },
      include: { tramite: { select: { id: true, consecutivo: true, estado: true, esHistorico: true } } },
    });
    if (!item) throw new ChecklistItemNoEncontradoError();

    await assertTramiteModificable(tx, item.tramite);

    const permiso = permisoItemChecklist({
      rol,
      estadoTramite: item.tramite.estado,
      esHistorico: item.tramite.esHistorico,
      descripcion: item.descripcion,
    });
    if (!permiso.ok) {
      // CERRADO ya lo rechazó el guard (409); aquí solo queda el rol del cuadre.
      throw new CuadreHistoricoRolError();
    }

    // Doble clic o reintento: mismo valor → nada que escribir ni auditar.
    const { tramite: _tramite, ...actual } = item;
    void _tramite;
    if (item.recibido === recibido) return actual;

    const actualizado = await tx.checklistItem.update({
      where: { id: item.id },
      data: {
        recibido,
        validadoPorId: recibido ? usuarioId : null,
        fechaValidacion: recibido ? new Date() : null,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "ChecklistItem",
        entidadId: item.id,
        accion: "UPDATE_CHECKLIST_ITEM",
        usuarioId,
        tramiteId,
        antes: snapshot(item),
        despues: { ...snapshot(actualizado), cuadreHistorico: permiso.cuadre },
      },
    });

    return actualizado;
  });
}
