import {
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoMovimientoCuenta,
} from "@prisma/client";
import { z } from "zod";

export const movimientoCuentaSchema = z.object({
  rol: z.nativeEnum(RolCuenta),
  tipo: z.nativeEnum(TipoMovimientoCuenta),
  /** COMPENSACION no se registra a mano: sale de `POST …/cuenta/compensaciones`. */
  origen: z.enum([
    OrigenMovimientoCuenta.CARGO_MANUAL,
    OrigenMovimientoCuenta.COMISION,
    OrigenMovimientoCuenta.AJUSTE,
  ]),
  /** Espejo de `TipoTramite.lineaServicio`. */
  lineaServicio: z.string().trim().min(1).max(40).default("TRAMITE"),
  concepto: z.string().trim().min(1, "El concepto es obligatorio").max(200),
  valor: z.coerce
    .bigint()
    .refine((valor) => valor > 0n, { message: "El valor debe ser mayor a 0" }),
  fecha: z.coerce.date(),
  tramiteId: z.string().min(1).optional().nullable(),
});

export type MovimientoCuentaPayload = z.infer<typeof movimientoCuentaSchema>;

/**
 * Cruce de saldos: salda el mismo importe en las dos puntas sin plata.
 * - Punta cliente: abono a una factura de venta (`facturaId`) o al libro manual.
 * - Punta proveedor: una factura de proveedor no repercutible (`facturaProveedorId`,
 *   pasa a PAGADA por el total) o el libro manual.
 * `valor` se puede omitir solo si viene `facturaProveedorId` (se toma su total).
 */
export const compensacionSchema = z
  .object({
    valor: z.coerce
      .bigint()
      .refine((valor) => valor > 0n, { message: "El valor debe ser mayor a 0" })
      .optional(),
    fecha: z.coerce.date(),
    concepto: z.string().trim().min(1, "El concepto es obligatorio").max(200),
    lineaServicio: z.string().trim().min(1).max(40).default("TRAMITE"),
    facturaId: z.string().min(1).optional().nullable(),
    facturaProveedorId: z.string().min(1).optional().nullable(),
  })
  .refine((c) => c.valor !== undefined || Boolean(c.facturaProveedorId), {
    path: ["valor"],
    message: "Indica el valor a cruzar (o elige una factura de proveedor, que fija el valor)",
  });

export type CompensacionPayload = z.infer<typeof compensacionSchema>;
