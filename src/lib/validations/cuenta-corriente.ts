import {
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoMovimientoCuenta,
} from "@prisma/client";
import { z } from "zod";

import { dineroSchema } from "@/lib/dinero";
import { fechaCalendarioSchema } from "@/lib/validations/comunes";

// Fase centavos: valores en PESOS de entrada ("502801.45" o número), CENTAVOS de salida (bigint).

/**
 * Fecha de un día del calendario (movimiento o cruce). Convención única de
 * CxP v2 (§D.7): "AAAA-MM-DD" → 00:00 UTC de ese día, mostrada en UTC con
 * `formatFechaCalendario`. Reemplaza el anclaje a mediodía de Bogotá de la
 * rama Coldex; las filas que ya quedaron a mediodía (17:00Z) se siguen
 * mostrando en su día (ver `aFechaCalendario`).
 */
const fechaDia = fechaCalendarioSchema;

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
  valor: dineroSchema.refine((valor) => valor > 0n, { message: "El valor debe ser mayor a 0" }),
  fecha: fechaDia,
  tramiteId: z.string().min(1).optional().nullable(),
  /** N° de la factura del proveedor ("Registrar factura de <proveedor>"). */
  numeroFactura: z.string().trim().min(1).max(40).optional(),
  /** PDF de soporte ya subido a la bodega (`POST …/cuenta/soporte`). */
  soporte: z
    .object({
      key: z.string().trim().min(1),
      nombre: z.string().trim().min(1),
      mime: z.string().trim().min(1),
    })
    .optional(),
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
    valor: dineroSchema.refine((valor) => valor > 0n, { message: "El valor debe ser mayor a 0" }).optional(),
    fecha: fechaDia,
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
