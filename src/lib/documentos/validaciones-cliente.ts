/**
 * Validación Zod de los query params de GET /api/clientes/[id]/documentos.
 * Sin BD — puramente esquema/transformación, testeable en aislamiento.
 */
import { CategoriaDocumento } from "@prisma/client";
import { z } from "zod";

// Acepta tanto fecha simple ("2026-01-31", de un <input type="date">) como
// datetime ISO completo. Se valida con Date.parse en vez de z.string().datetime()
// para no exigir formato con hora/zona en filtros de fecha de UI.
const fechaFiltroSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Fecha inválida (use formato ISO, ej. 2026-01-31)",
  })
  .transform((value) => new Date(value))
  .optional();

export const documentosClienteQuerySchema = z
  .object({
    categoria: z.nativeEnum(CategoriaDocumento).optional(),
    desde: fechaFiltroSchema,
    hasta: fechaFiltroSchema,
    take: z.coerce.number().int().min(1).max(100).default(50),
    skip: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => !data.desde || !data.hasta || data.desde <= data.hasta, {
    message: "'desde' debe ser anterior o igual a 'hasta'",
    path: ["desde"],
  });

export type DocumentosClienteQuery = z.infer<typeof documentosClienteQuerySchema>;
