/**
 * Guard transversal de trámite cerrado — Galcomex
 *
 * Decisión de negocio (reunión 1-jul): "Bloqueo total al cerrar el trámite:
 * nadie puede modificar nada una vez cerrado." CERRADO es el estado terminal
 * del ciclo de vida del TramiteDO (ver EstadoTramite / transitionMap en
 * src/lib/tramites/service.ts).
 *
 * `assertTramiteModificable` es el punto único que TODAS las mutaciones que
 * operan sobre un trámite (o sobre una entidad hija de un trámite: pagos,
 * anticipos aplicados, facturas de proveedor, documentos, borradores/líneas,
 * checklist) deben invocar al inicio de su transacción, antes de escribir
 * nada. Lanza `TramiteCerradoError` (409) si el trámite está CERRADO.
 *
 * EXCEPCIÓN explícita: la propia transición de estado del trámite hacia o
 * desde CERRADO se maneja en `transitionTramite` (src/lib/tramites/service.ts)
 * con su propia lógica de reapertura (solo ADMIN) — ese código NO llama a
 * este guard sobre sí mismo.
 */

import { EstadoTramite, type Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

/** Cliente de BD aceptado por el guard: la conexión principal o un cliente de transacción. */
type Db = typeof prisma | Prisma.TransactionClient;

/** Forma mínima de TramiteDO que necesita el guard para decidir y para el mensaje de error. */
export type TramiteEstadoMinimo = {
  id: string;
  consecutivo: string;
  estado: EstadoTramite;
};

export class TramiteCerradoError extends Error {
  public readonly status = 409;
  public readonly tramiteId: string;
  public readonly consecutivo: string;

  constructor(tramite: Pick<TramiteEstadoMinimo, "id" | "consecutivo">) {
    super(`El trámite ${tramite.consecutivo} está cerrado y no admite modificaciones`);
    this.name = "TramiteCerradoError";
    this.tramiteId = tramite.id;
    this.consecutivo = tramite.consecutivo;
  }
}

/**
 * Verifica que el trámite indicado admita modificaciones (estado !== CERRADO).
 * Lanza TramiteCerradoError si está cerrado.
 *
 * Acepta:
 *  - un `tramiteId` (string): hace un fetch mínimo (id, consecutivo, estado)
 *    contra `db`. Si el trámite no existe, NO lanza aquí — el caller ya tiene
 *    (o va a tener) su propia validación de "no encontrado" con el mensaje/
 *    status apropiados a su contexto; este guard solo se pronuncia sobre
 *    trámites que sí existen.
 *  - un objeto ya cargado `{ id, consecutivo, estado }`: evita duplicar la
 *    query cuando el caller ya hizo el fetch del trámite (o de una entidad
 *    que lo incluye, p.ej. `pago.tramite`).
 *
 * Debe llamarse DENTRO de la misma transacción de la mutación (pasando `tx`
 * como `db`) para que la verificación sea consistente con la escritura.
 */
export async function assertTramiteModificable(
  db: Db,
  tramiteOrId: string | TramiteEstadoMinimo,
): Promise<void> {
  const tramite: TramiteEstadoMinimo | null =
    typeof tramiteOrId === "string"
      ? await db.tramiteDO.findUnique({
          where: { id: tramiteOrId },
          select: { id: true, consecutivo: true, estado: true },
        })
      : tramiteOrId;

  if (!tramite) {
    return;
  }

  if (tramite.estado === EstadoTramite.CERRADO) {
    throw new TramiteCerradoError(tramite);
  }
}
