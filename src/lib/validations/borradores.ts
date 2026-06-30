/**
 * Esquemas Zod para endpoints de borradores y facturas — Galcomex
 */

import { CanalPago, EstadoBorrador, SeccionLinea, TipoRecaudo } from "@prisma/client";
import { z } from "zod";

/** Comisión interna Galcomex→Lucho: piso del acuerdo, valida en API y servicio. */
export const COMISION_INTERNA_LM_MINIMO = 150_000n;

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

// ── Líneas manuales del borrador ────────────────────────────────────────────

export const crearLineaPayloadSchema = z.object({
  concepto: z.string().trim().min(1, "El concepto es obligatorio"),
  numSoporte: z.string().trim().min(1).optional(),
  valor: z.coerce.bigint().positive(),
  observacion: z.string().trim().min(1).optional(),
  /** Subsección de la factura: TERCEROS (default) u OPERACIONAL. */
  seccion: z.nativeEnum(SeccionLinea).default(SeccionLinea.TERCEROS),
  /** Facturas de proveedor que respaldan esta línea (N↔N). */
  facturaIds: z.array(z.string().min(1)).default([]),
  /** Producto del catálogo Siigo vinculado a esta línea. */
  siigoProductoId: z.string().min(1).optional(),
  /** NIT del tercero ("Id. Tercero" en Siigo) si la línea no vincula factura. */
  nitTercero: z.string().trim().min(1).optional(),
});

export type CrearLineaPayload = z.infer<typeof crearLineaPayloadSchema>;

export const actualizarLineaPayloadSchema = z
  .object({
    concepto: z.string().trim().min(1).optional(),
    numSoporte: z.string().trim().min(1).nullable().optional(),
    valor: z.coerce.bigint().positive().optional(),
    observacion: z.string().trim().min(1).nullable().optional(),
    seccion: z.nativeEnum(SeccionLinea).optional(),
    facturaIds: z.array(z.string().min(1)).optional(),
    siigoProductoId: z.string().min(1).nullable().optional(),
    /** NIT del tercero (null limpia el campo). */
    nitTercero: z.string().trim().min(1).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debe enviarse al menos un campo a actualizar",
  });

export type ActualizarLineaPayload = z.infer<typeof actualizarLineaPayloadSchema>;

// ── Actualizar comisión ──────────────────────────────────────────────────────

export const actualizarComisionPayloadSchema = z.object({
  /** Nueva comisión (COP, BigInt). El IVA se recalcula desde tasaIva. */
  comision: z.coerce.bigint().nonnegative(),
});

export type ActualizarComisionPayload = z.infer<typeof actualizarComisionPayloadSchema>;

// ── Actualizar comisión interna LM (cruce) ────────────────────────────────────

export const actualizarComisionInternaLMPayloadSchema = z
  .object({
    /** Comisión interna Galcomex→Lucho (COP, BigInt). Solo afecta el cruce interno.
     *  Piso del acuerdo: COMISION_INTERNA_LM_MINIMO (150.000). */
    comisionInternaLM: z.coerce
      .bigint()
      .refine((v) => v >= COMISION_INTERNA_LM_MINIMO, {
        message: `La comisión interna LM no puede ser menor a ${COMISION_INTERNA_LM_MINIMO} COP`,
      }),
    /** Tipo de pago: exactamente uno de (tipoRecaudo, canalPago) debe estar set. */
    tipoRecaudoComisionInternaLM: z.nativeEnum(TipoRecaudo).optional(),
    canalPagoComisionInternaLM: z.nativeEnum(CanalPago).optional(),
  })
  .refine(
    (d) =>
      (d.tipoRecaudoComisionInternaLM !== undefined) !==
      (d.canalPagoComisionInternaLM !== undefined),
    {
      message:
        "Debe especificarse exactamente uno de tipoRecaudoComisionInternaLM o canalPagoComisionInternaLM.",
      path: ["tipoRecaudoComisionInternaLM"],
    },
  );

export type ActualizarComisionInternaLMPayload = z.infer<
  typeof actualizarComisionInternaLMPayloadSchema
>;

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

const fechaIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha debe tener formato YYYY-MM-DD")
  .optional();

export const carteraQuerySchema = z.object({
  clienteId: z.string().min(1, "clienteId es obligatorio"),
  pendientes: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  desde: fechaIso,
  hasta: fechaIso,
});

// ── Liquidación por lotes LM (cuenta Lucho) ───────────────────────────────────

export const liquidacionLMQuerySchema = z.object({
  desde: fechaIso,
  hasta: fechaIso,
});

export type LiquidacionLMQuery = z.infer<typeof liquidacionLMQuerySchema>;
