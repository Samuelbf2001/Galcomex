/**
 * Esquemas Zod para endpoints de borradores y facturas — Galcomex
 */

import { EstadoBorrador } from "@prisma/client";
import { z } from "zod";

// ── Generar borrador ──────────────────────────────────────────────────────────

export const generarBorradorPayloadSchema = z.object({
  /** Override de comisión (COP). Si no se pasa, se usa COMISION_LM del Parametro. */
  comision: z.coerce.bigint().positive().optional(),
  /** Override de IVA de comisión. Si no se pasa, se calcula desde tasaIva. */
  ivaComision: z.coerce.bigint().nonnegative().optional(),
  /** Monto atribuible al socio LM. Si no se pasa, default 0. */
  montoLM: z.coerce.bigint().nonnegative().optional(),
  /** Total de retenciones (RETE IVA + RETE FTE + RETE ICA). Default 0. */
  retenciones: z.coerce.bigint().nonnegative().optional(),
  /** Desglose de la comisión; su suma debe igualar la comisión efectiva. */
  conceptosOperacionales: z
    .array(
      z.object({
        concepto: z.string().trim().min(1),
        valor: z.coerce.bigint().positive(),
      }),
    )
    .min(1)
    .optional(),
});

export type GenerarBorradorPayload = z.infer<typeof generarBorradorPayloadSchema>;

// ── Transición de estado ──────────────────────────────────────────────────────

export const transicionBorradorPayloadSchema = z
  .object({
    nuevoEstado: z.nativeEnum(EstadoBorrador),
    /** Obligatorio al facturar (→FACTURADO) */
    numFacturaSiigo: z.string().trim().min(1).optional(),
    /** Obligatorio al facturar (→FACTURADO) */
    fechaFactura: z.coerce.date().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.nuevoEstado === EstadoBorrador.FACTURADO) {
      if (!data.numFacturaSiigo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["numFacturaSiigo"],
          message: "numFacturaSiigo es obligatorio al facturar",
        });
      }
      if (!data.fechaFactura) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fechaFactura"],
          message: "fechaFactura es obligatoria al facturar",
        });
      }
    }
  });

export type TransicionBorradorPayload = z.infer<typeof transicionBorradorPayloadSchema>;

// ── Registrar pago de factura ─────────────────────────────────────────────────

export const registrarPagoFacturaPayloadSchema = z
  .object({
    fechaPagoCliente: z.coerce.date().optional(),
    fechaPagoLM: z.coerce.date().optional(),
  })
  .refine((d) => d.fechaPagoCliente !== undefined || d.fechaPagoLM !== undefined, {
    message: "Debe especificarse al menos fechaPagoCliente o fechaPagoLM",
  });

export type RegistrarPagoFacturaPayload = z.infer<typeof registrarPagoFacturaPayloadSchema>;

// ── Cartera query ─────────────────────────────────────────────────────────────

export const carteraQuerySchema = z.object({
  clienteId: z.string().min(1, "clienteId es obligatorio"),
  pendientes: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});
