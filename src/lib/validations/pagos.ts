import { CanalPago } from "@prisma/client";
import { z } from "zod";

export const crearPagoSchema = z.object({
  concepto: z.string().trim().min(1, "El concepto es obligatorio"),
  beneficiarioId: z.string().min(1).optional().nullable(),
  numSoporte: z.string().trim().min(1).optional().nullable(),
  documentoId: z.string().min(1).optional().nullable(),
  valor: z.coerce
    .bigint()
    .refine((v) => v >= 0n, { message: "El valor no puede ser negativo" }),
  canalPago: z.nativeEnum(CanalPago),
  fechaEsperadaPago: z.coerce.date().optional().nullable(),
  fechaRealPago: z.coerce.date().optional().nullable(),
  facturaProveedorId: z.string().min(1).optional().nullable(),
});

export const listarPagosQuerySchema = z.object({
  clienteId: z.string().min(1).optional(),
  tramiteId: z.string().min(1).optional(),
  canalPago: z.nativeEnum(CanalPago).optional(),
  soloPendientes: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export const actualizarPagoSchema = z.object({
  canalPago: z.nativeEnum(CanalPago).optional(),
  valor: z.coerce
    .bigint()
    .refine((v) => v >= 0n, { message: "El valor no puede ser negativo" })
    .optional(),
  concepto: z.string().trim().min(1).optional(),
  beneficiarioId: z.string().min(1).optional().nullable(),
  numSoporte: z.string().trim().min(1).optional().nullable(),
  fechaEsperadaPago: z.coerce.date().optional().nullable(),
  fechaRealPago: z.coerce.date().optional().nullable(),
});
