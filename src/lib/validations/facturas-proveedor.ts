import { CanalPago } from "@prisma/client";
import { z } from "zod";

export const crearFacturaProveedorSchema = z.object({
  proveedorNombre: z.string().trim().min(1, "El nombre del proveedor es obligatorio"),
  proveedorNit: z.string().trim().min(1).optional().nullable(),
  /** ID del Beneficiario unificado (reemplaza proveedorNombre/NIT en el flujo nuevo) */
  beneficiarioId: z.string().min(1).optional().nullable(),
  concepto: z.string().trim().min(1).optional().nullable(),
  numFactura: z.string().trim().min(1, "El número de factura es obligatorio"),
  valor: z.coerce
    .bigint()
    .refine((v) => v > 0n, { message: "El valor debe ser mayor a 0" }),
  fecha: z.coerce.date(),
  /** Archivo obligatorio para nuevas facturas (validado también en UI) */
  documentoId: z.string().min(1, "El archivo de la factura es obligatorio"),
});

export const actualizarFacturaProveedorSchema = z.object({
  proveedorNombre: z.string().trim().min(1).optional(),
  proveedorNit: z.string().trim().min(1).optional().nullable(),
  beneficiarioId: z.string().min(1).optional().nullable(),
  concepto: z.string().trim().min(1).optional().nullable(),
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
