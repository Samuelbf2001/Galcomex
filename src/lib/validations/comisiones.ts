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
