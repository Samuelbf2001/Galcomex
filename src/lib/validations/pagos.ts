import { CanalPago, EstadoMovimiento } from "@prisma/client";
import { z } from "zod";

export const crearPagoSchema = z.object({
  concepto: z.string().trim().min(1, "El concepto es obligatorio"),
  /** IDs de beneficiarios (N↔N). Vacío = sin beneficiario. */
  beneficiarioIds: z.array(z.string().min(1)).optional().default([]),
  numSoporte: z.string().trim().min(1).optional().nullable(),
  documentoId: z.string().min(1).optional().nullable(),
  valor: z.coerce
    .bigint()
    .refine((v) => v >= 0n, { message: "El valor no puede ser negativo" }),
  canalPago: z.nativeEnum(CanalPago),
  fechaRealPago: z.coerce.date().optional().nullable(),
  /** IDs de facturas de proveedor a vincular (N↔N). Vacío = pago manual sin vinculación. */
  facturaProveedorIds: z.array(z.string().min(1)).optional().default([]),
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
  /** Si se provee, reemplaza todos los beneficiarios vinculados al pago. */
  beneficiarioIds: z.array(z.string().min(1)).optional(),
  numSoporte: z.string().trim().min(1).optional().nullable(),
  fechaRealPago: z.coerce.date().optional().nullable(),
});

export const verificarMovimientoSchema = z.object({
  estado: z.nativeEnum(EstadoMovimiento),
});
