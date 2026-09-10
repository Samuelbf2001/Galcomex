import { z } from "zod";

export const eventoMarcadoSchema = z.object({
  codigo: z.string().trim().min(1).max(60),
  cantidad: z.number().int().min(1).max(999).default(1),
  observacion: z.string().trim().max(300).optional().nullable(),
});

/**
 * PUT /api/tramites/[id]/eventos — reemplaza el conjunto de eventos marcados.
 * La UI manda la lista completa (checks): lo que no viene, se desmarca.
 */
export const marcarEventosSchema = z.object({
  eventos: z.array(eventoMarcadoSchema).max(50),
});

export type EventoMarcadoPayload = z.infer<typeof eventoMarcadoSchema>;
export type MarcarEventosPayload = z.infer<typeof marcarEventosSchema>;
