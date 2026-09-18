import { CanalPago } from "@prisma/client";
import { z } from "zod";

export const MENSAJE_ARCHIVO_OBLIGATORIO =
  "El archivo de la factura es obligatorio. Solo se puede omitir en un costo propio que no se le cobra al cliente (por ejemplo, la clasificadora).";

export const crearFacturaProveedorSchema = z
  .object({
  proveedorNombre: z.string().trim().min(1, "El nombre del proveedor es obligatorio"),
  proveedorNit: z.string().trim().min(1).optional().nullable(),
  /** ID del Beneficiario unificado (reemplaza proveedorNombre/NIT en el flujo nuevo) */
  beneficiarioId: z.string().min(1).optional().nullable(),
  concepto: z.string().trim().min(1).optional().nullable(),
  siigoProductoId: z.string().min(1).optional().nullable(),
  numFactura: z.string().trim().min(1, "El número de factura es obligatorio"),
  valor: z.coerce
    .bigint()
    .refine((v) => v > 0n, { message: "El valor debe ser mayor a 0" }),
  fecha: z.coerce.date(),
  /**
   * Archivo de la factura. Obligatorio si se le cobra al cliente: es el soporte
   * del ítem de terceros en la factura de venta. En un costo propio (no
   * repercutible) es opcional: la clasificadora no emite factura, solo cobra,
   * y el soporte es el comprobante del pago.
   */
  documentoId: z.string().min(1).optional().nullable(),
  /**
   * ¿Se traslada al cliente en la factura de venta? (M6). Default `true`:
   * el caso normal es que el gasto se pague por cuenta del cliente. En `false`
   * la factura queda en el trámite para pagarla, pero el cliente no la ve.
   */
  repercutible: z.boolean().default(true),
})
  .superRefine((data, ctx) => {
    if (data.repercutible && !data.documentoId) {
      ctx.addIssue({ code: "custom", path: ["documentoId"], message: MENSAJE_ARCHIVO_OBLIGATORIO });
    }
  });

export const actualizarFacturaProveedorSchema = z.object({
  proveedorNombre: z.string().trim().min(1).optional(),
  proveedorNit: z.string().trim().min(1).optional().nullable(),
  beneficiarioId: z.string().min(1).optional().nullable(),
  concepto: z.string().trim().min(1).optional().nullable(),
  siigoProductoId: z.string().min(1).optional().nullable(),
  numFactura: z.string().trim().min(1).optional(),
  valor: z.coerce
    .bigint()
    .refine((v) => v > 0n, { message: "El valor debe ser mayor a 0" })
    .optional(),
  fecha: z.coerce.date().optional(),
  documentoId: z.string().min(1).optional().nullable(),
  repercutible: z.boolean().optional(),
});

export const generarPagoDesdeFacturaSchema = z.object({
  canalPago: z.nativeEnum(CanalPago),
  viaSocio: z.boolean().default(false),
  fechaRealPago: z.coerce.date().optional().nullable(),
});

export const solicitarFacturacionSchema = z.object({}).optional();
