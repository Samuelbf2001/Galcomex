import { z } from "zod";

import { esCodigoCapacidad, type CodigoCapacidad } from "@/lib/capacidades/catalogo";

const codigoCapacidadSchema = z.custom<CodigoCapacidad>(
  (valor) => typeof valor === "string" && esCodigoCapacidad(valor),
  { message: "Capacidad desconocida" },
);

export const cambioCapacidadSchema = z
  .object({
    codigo: codigoCapacidadSchema,
    /** Borra el override propio y devuelve la capacidad a lo que herede. */
    heredar: z.boolean().optional(),
    habilitado: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine(
    (cambio) =>
      cambio.heredar === true ||
      cambio.habilitado !== undefined ||
      cambio.config !== undefined,
    { message: "El cambio debe indicar habilitado, config o heredar" },
  );

export const capacidadesPayloadSchema = z.object({
  cambios: z.array(cambioCapacidadSchema).min(1).max(50),
});

export type CapacidadesPayload = z.infer<typeof capacidadesPayloadSchema>;
