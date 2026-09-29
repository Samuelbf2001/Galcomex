import { TipoRecaudo } from "@prisma/client";
import { z } from "zod";

import { dineroSchema } from "@/lib/dinero";

// Fase centavos: montos en PESOS de entrada ("502801.45" o número), CENTAVOS de salida (bigint).

export const crearAnticipoSchema = z.object({
  clienteId: z.string().min(1, "El clienteId es obligatorio"),
  monto: dineroSchema.refine((v) => v > 0n, { message: "El monto debe ser mayor a 0" }),
  fecha: z.coerce.date(),
  tipoRecaudo: z.nativeEnum(TipoRecaudo),
  soporteKey: z.string().min(1).optional().nullable(),
  verificadoBanco: z.boolean().default(false),
});

export const aplicarAnticipoSchema = z.object({
  tramiteId: z.string().min(1, "El tramiteId es obligatorio"),
  montoAplicado: dineroSchema.refine((v) => v > 0n, { message: "El montoAplicado debe ser mayor a 0" }),
});

export const listarAnticiposQuerySchema = z.object({
  clienteId: z.string().min(1).optional(),
  conSaldo: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});
