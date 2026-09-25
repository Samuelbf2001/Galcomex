/**
 * Marcar o desmarcar un ítem del checklist del trámite — Galcomex.
 *
 * Único punto de escritura de `ChecklistItem.recibido` desde la app
 * (`PATCH /api/tramites/[id]/checklist/[itemId]`). En una sola transacción:
 * valida que el trámite no esté CERRADO, aplica la regla del ítem de cuadre
 * de plata histórica (solo ADMIN/REVISOR, ver `cuadre-historico.ts`) y deja
 * un AuditLog `UPDATE_CHECKLIST_ITEM` con antes y después para TODOS los
 * ítems (invariante 5). Marcar el mismo valor que ya tiene no escribe nada.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { permisoItemChecklist } from "@/lib/tramites/cuadre-historico";
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
