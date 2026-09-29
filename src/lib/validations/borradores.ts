/**
 * Esquemas Zod para endpoints de borradores y facturas — Galcomex
 *
 * Fase centavos (diseño A.2): el dinero llega en PESOS (texto "150000" /
 * "150000.50" o number) y sale del esquema en CENTAVOS (`bigint`), con los
 * esquemas únicos del núcleo (`@/lib/dinero`). Rechaza "150.000", "1e5" y más
 * de 2 decimales.
 */

import { CanalPago, EstadoBorrador, SeccionLinea, TipoRecaudo } from "@prisma/client";
import { z } from "zod";

import {
  dineroNoNegativoSchema,
  dineroPositivoSchema,
  dineroSchema,
  formatoPesos,
  pesos,
} from "@/lib/dinero";

/** Comisión interna Galcomex→Lucho: piso del acuerdo ($150.000, en CENTAVOS), valida en API y servicio. */
export const COMISION_INTERNA_LM_MINIMO = pesos(150_000);

// ── Generar borrador ──────────────────────────────────────────────────────────

export const generarBorradorPayloadSchema = z.object({
  /** Override de comisión (pesos → centavos). Si no se pasa, se usa COMISION_LM del Parametro. */
  comision: dineroPositivoSchema.optional(),
  /** Override de IVA de comisión. Si no se pasa, se calcula desde tasaIva (al peso). */
  ivaComision: dineroNoNegativoSchema.optional(),
  /** Monto atribuible al socio LM. Si no se pasa, default 0. */
  montoLM: dineroNoNegativoSchema.optional(),
  /** Total de retenciones (RETE IVA + RETE FTE + RETE ICA). Default 0. */
  retenciones: dineroNoNegativoSchema.optional(),
  /** Desglose de la comisión; su suma debe igualar la comisión efectiva. */
  conceptosOperacionales: z
    .array(
      z.object({
        concepto: z.string().trim().min(1),
        valor: dineroPositivoSchema,
      }),
    )
    .min(1)
    .optional(),
  /**
   * Generar con el tarifario vigente de la empresa (modal "Generar borrador").
   * Si el servidor no puede aplicarlo (ya no hay tarifario vigente, cambió de
   * versión, no propone líneas) responde 409 en vez de caer en silencio a la
   * comisión por defecto. Excluye `comision` y `conceptosOperacionales`.
   */
  usarTarifario: z.boolean().optional(),
  /** Tarifario que el revisor vio en la propuesta; si ya no es el que rige → 409. */
  tarifarioId: z.string().trim().min(1).optional(),
  /**
   * Total del tarifario (sin IVA, pesos texto) que el revisor vio en la
   * propuesta. Si al generar el tarifario da otro total (cambió la base del DO
   * o un costo que un ítem ESPEJO refleja) → 409, aunque la versión sea la misma.
   */
  totalTarifario: dineroNoNegativoSchema.optional(),
}).superRefine((payload, ctx) => {
  if (payload.usarTarifario && (payload.comision !== undefined || payload.conceptosOperacionales)) {
    ctx.addIssue({
      code: "custom",
      path: ["usarTarifario"],
      message: "Con el tarifario no se manda comisión ni conceptos a mano",
    });
  }
  if (payload.totalTarifario !== undefined && !payload.usarTarifario) {
    ctx.addIssue({
      code: "custom",
      path: ["totalTarifario"],
      message: "totalTarifario solo aplica con usarTarifario: true",
    });
  }
  if (payload.tarifarioId && !payload.usarTarifario) {
    ctx.addIssue({
      code: "custom",
      path: ["tarifarioId"],
      message: "tarifarioId solo aplica con usarTarifario: true",
    });
  }
});

export type GenerarBorradorPayload = z.infer<typeof generarBorradorPayloadSchema>;

// ── Líneas manuales del borrador ────────────────────────────────────────────

export const crearLineaPayloadSchema = z.object({
  concepto: z.string().trim().min(1, "El concepto es obligatorio"),
  numSoporte: z.string().trim().min(1).optional(),
  /** Pesos → centavos (admite centavos: "502801.45"). */
  valor: dineroPositivoSchema,
  observacion: z.string().trim().min(1).optional(),
  /** Subsección de la factura: TERCEROS (default) u OPERACIONAL. */
  seccion: z.nativeEnum(SeccionLinea).default(SeccionLinea.TERCEROS),
  /** Facturas de proveedor que respaldan esta línea (N↔N). */
  facturaIds: z.array(z.string().min(1)).default([]),
  /** Producto del catálogo Siigo vinculado a esta línea. */
  siigoProductoId: z.string().min(1).optional(),
  /** NIT del tercero ("Id. Tercero" en Siigo) si la línea no vincula factura. */
  nitTercero: z.string().trim().min(1).optional(),
  /** Lleva IVA como ítem (formato CONCEPTOS_IVA). Sin valor: sí en OPERACIONAL de ese formato. */
  aplicaIva: z.boolean().optional(),
});

export type CrearLineaPayload = z.infer<typeof crearLineaPayloadSchema>;

export const actualizarLineaPayloadSchema = z
  .object({
    concepto: z.string().trim().min(1).optional(),
    numSoporte: z.string().trim().min(1).nullable().optional(),
    valor: dineroPositivoSchema.optional(),
    observacion: z.string().trim().min(1).nullable().optional(),
    seccion: z.nativeEnum(SeccionLinea).optional(),
    facturaIds: z.array(z.string().min(1)).optional(),
    siigoProductoId: z.string().min(1).nullable().optional(),
    /** NIT del tercero (null limpia el campo). */
    nitTercero: z.string().trim().min(1).nullable().optional(),
    /** Lleva IVA como ítem (formato CONCEPTOS_IVA). */
    aplicaIva: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debe enviarse al menos un campo a actualizar",
  });

export type ActualizarLineaPayload = z.infer<typeof actualizarLineaPayloadSchema>;

// ── Actualizar comisión ──────────────────────────────────────────────────────

export const actualizarComisionPayloadSchema = z.object({
  /** Nueva comisión (pesos → centavos). El IVA se recalcula desde tasaIva (al peso). */
  comision: dineroNoNegativoSchema,
});

export type ActualizarComisionPayload = z.infer<typeof actualizarComisionPayloadSchema>;

// ── Actualizar comisión interna LM (cruce) ────────────────────────────────────

export const actualizarComisionInternaLMPayloadSchema = z
  .object({
    /** Comisión interna Galcomex→Lucho (pesos → centavos). Solo afecta el cruce interno.
     *  Piso del acuerdo: COMISION_INTERNA_LM_MINIMO ($150.000). */
    comisionInternaLM: dineroSchema.refine((v) => v >= COMISION_INTERNA_LM_MINIMO, {
      message: `La comisión interna LM no puede ser menor a ${formatoPesos(COMISION_INTERNA_LM_MINIMO)}`,
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

// ── Enviar a SIIGO ────────────────────────────────────────────────────────────

/**
 * Cuerpo (opcional) de POST /api/borradores/[id]/siigo-enviar. Sin cuerpo es un
 * primer envío. Reenviar exige nombrar el borrador de Siigo que se reemplaza.
 */
export const enviarSiigoPayloadSchema = z
  .object({
    reenviar: z.boolean().optional(),
    siigoDraftIdAnterior: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.reenviar && !data.siigoDraftIdAnterior) {
      ctx.addIssue({
        code: "custom",
        path: ["siigoDraftIdAnterior"],
        message: "Para reenviar indica el borrador de SIIGO que se reemplaza (siigoDraftIdAnterior).",
      });
    }
  });

export type EnviarSiigoPayload = z.infer<typeof enviarSiigoPayloadSchema>;

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
  /** Línea de servicio del tipo de trámite (TRAMITE, CLASIFICACION, PLAN_VALLEJO…). Sin valor = todas. */
  lineaServicio: z.string().trim().min(1).max(40).optional(),
});

// ── Liquidación por lotes LM (cuenta Lucho) ───────────────────────────────────

export const liquidacionLMQuerySchema = z.object({
  desde: fechaIso,
  hasta: fechaIso,
});

export type LiquidacionLMQuery = z.infer<typeof liquidacionLMQuerySchema>;

// ── Consulta por lote (GET /api/facturacion/borradores) ─────────────────────

/** Máximo de trámites por llamada al endpoint de lote. */
export const BORRADORES_LOTE_MAXIMO = 100;

/**
 * `?tramiteIds=id1,id2,...` → array de ids únicos, sin vacíos, 1..100.
 * Los duplicados se colapsan antes de validar el máximo.
 */
export const borradoresLoteQuerySchema = z.object({
  tramiteIds: z
    .string({ error: "tramiteIds es obligatorio (ids separados por coma)" })
    .transform((raw) =>
      Array.from(
        new Set(
          raw
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        ),
      ),
    )
    .pipe(
      z
        .array(z.string().min(1))
        .min(1, "Indica al menos un tramiteId")
        .max(BORRADORES_LOTE_MAXIMO, `Máximo ${BORRADORES_LOTE_MAXIMO} trámites por llamada`),
    ),
});

export type BorradoresLoteQuery = z.infer<typeof borradoresLoteQuerySchema>;
