/**
 * Helpers de API para el checklist documental del trámite.
 * Contrato: PATCH /api/tramites/[id]/checklist/[itemId]
 * Roles admitidos por el backend: ADMIN, REVISOR, OPERATIVO (ver route.ts).
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ChecklistItem = {
  id: string;
  descripcion: string;
  requerido: boolean;
  recibido: boolean;
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class ChecklistApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ChecklistApiError";
    this.status = status;
  }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(raw: Record<string, unknown>): ChecklistItem {
  return {
    id: String(raw.id ?? ""),
    descripcion: String(raw.descripcion ?? ""),
    requerido: Boolean(raw.requerido),
    recibido: Boolean(raw.recibido),
  };
}

// ─── PATCH item de checklist ───────────────────────────────────────────────────

/**
 * Marca (o desmarca) un ítem del checklist documental como recibido.
 * El backend exige rol ADMIN, REVISOR u OPERATIVO (requireRole en la route).
 */
export async function patchChecklistItem(
  tramiteId: string,
  itemId: string,
  recibido: boolean,
): Promise<ChecklistItem> {
  let response: Response;
  try {
    response = await fetch(`/api/tramites/${tramiteId}/checklist/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ recibido }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChecklistApiError("No fue posible conectar con la API del checklist.");
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error ${response.status}`;
    throw new ChecklistApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new ChecklistApiError("Respuesta inesperada al actualizar el checklist.");
  }

  return normalizeItem(payload.item);
}
