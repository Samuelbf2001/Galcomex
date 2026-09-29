import { Ciudad } from "@prisma/client";
import { z } from "zod";

/**
 * `PUT /api/tramites/[id]/comisiones`: cuántos contenedores del DO llevan
 * comisión de una empresa (LTRANS). `unidades = 0` quita la comisión.
 */
export const comisionTramiteSchema = z.object({
  empresaId: z
    .string({ error: "Indica la empresa que paga la comisión." })
    .trim()
    .min(1, "Indica la empresa que paga la comisión."),
  unidades: z
    .number({ error: "Escribe cuántos contenedores llevan comisión." })
    .int("Los contenedores con comisión deben ser un número entero.")
    .min(0, "Los contenedores con comisión no pueden ser negativos.")
    .max(100_000, "Demasiados contenedores."),
});

export type ComisionTramitePayload = z.infer<typeof comisionTramiteSchema>;

/**
 * `POST /api/clientes/[id]/comisiones/liquidar` (B10): las comisiones por
 * contenedor que se facturan juntas en un «Otros» a nombre de la empresa que
 * paga. `ciudad` solo decide el consecutivo del «Otros» (por defecto BAQ).
 */
export const liquidarComisionesSchema = z.object({
  comisionIds: z
    .array(
      z
        .string({ error: "Cada comisión debe ser un id." })
        .trim()
        .min(1, "Cada comisión debe ser un id."),
      { error: "Escoge las comisiones que se van a facturar." },
    )
    .min(1, "Escoge al menos una comisión para facturar.")
    .max(500, "Demasiadas comisiones en una sola factura (máximo 500)."),
  ciudad: z.nativeEnum(Ciudad).optional(),
});

export type LiquidarComisionesPayload = z.infer<typeof liquidarComisionesSchema>;
