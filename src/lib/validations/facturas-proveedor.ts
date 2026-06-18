import { CanalPago } from "@prisma/client";
import { z } from "zod";

export const crearFacturaProveedorSchema = z.object({
  proveedorNombre: z.string().trim().min(1, "El nombre del proveedor es obligatorio"),
  proveedorNit: z.string().trim().min(1).optional().nullable(),
  numFactura: z.string().trim().min(1, "El número de factura es obligatorio"),
  valor: z.coerce
    .bigint()
    .refine((v) => v > 0n, { message: "El valor debe ser mayor a 0" }),
  fecha: z.coerce.date(),
  documentoId: z.string().min(1).optional().nullable(),
});

export const actualizarFacturaProveedorSchema = z.object({
  proveedorNombre: z.string().trim().min(1).optional(),
  proveedorNit: z.string().trim().min(1).optional().nullable(),
  numFactura: z.string().trim().min(1).optional(),
  valor: z.coerce
    .bigint()
    .refine((v) => v > 0n, { message: "El valor debe ser mayor a 0" })
    .optional(),
  fecha: z.coerce.date().optional(),
  documentoId: z.string().min(1).optional().nullable(),
});

export const generarPagoDesdeFacturaSchema = z.object({
  canalPago: z.nativeEnum(CanalPago),
  viaSocio: z.boolean().default(false),
  fechaRealPago: z.coerce.date().optional().nullable(),
});

export const solicitarFacturacionSchema = z.object({}).optional();
