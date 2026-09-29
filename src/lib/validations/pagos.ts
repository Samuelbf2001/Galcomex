import { CanalPago, EstadoMovimiento } from "@prisma/client";
import { z } from "zod";

import { dineroNoNegativoSchema, dineroPositivoSchema } from "@/lib/dinero";
import { claveIdempotenciaSchema, fechaCalendarioOpcionalSchema, motivoSchema } from "@/lib/validations/comunes";

/*
 * Fase centavos: el dinero llega en PESOS (texto "502801.45" o número; hasta
 * 2 decimales, sin separador de miles) y sale en CENTAVOS (`bigint`).
 */

/** Una aplicación del pago a una factura de proveedor (CxP v2). */
const aplicacionSchema = z.object({
  facturaProveedorId: z.string().min(1),
  monto: dineroPositivoSchema,
});

export const crearPagoSchema = z
  .object({
    concepto: z.string().trim().min(1, "El concepto es obligatorio"),
    /** IDs de beneficiarios (N↔N). Vacío + facturas = se completa con el proveedor de la factura. */
    beneficiarioIds: z.array(z.string().min(1)).optional().default([]),
    numSoporte: z.string().trim().min(1).optional().nullable(),
    /** Comprobante bancario — opcional en el pago suelto, no lo bloquea. */
    documentoId: z.string().min(1).optional().nullable(),
    /** Comprobante de la página del comercio (puerto/PSE) — opcional. */
    comprobanteComercioId: z.string().min(1).optional().nullable(),
    valor: dineroNoNegativoSchema,
    canalPago: z.nativeEnum(CanalPago),
    /** Fecha-calendario ("YYYY-MM-DD" → 00:00 UTC del día). */
    fechaRealPago: fechaCalendarioOpcionalSchema,
    /**
     * CxP v2: cuánto de este pago va a cada factura (Σ = valor). Es la entrada
     * de la pantalla ("Pagar $saldo", selector del libro de pagos).
     */
    aplicaciones: z.array(aplicacionSchema).optional().default([]),
    /**
     * Entrada heredada (MCP / scripts): el valor se reparte FIFO entre estas
     * facturas, cada una hasta su saldo. Exige valor > 0. No se combina con `aplicaciones`.
     */
    facturaProveedorIds: z.array(z.string().min(1)).optional().default([]),
    /**
     * Banco (Beneficiario) usado como tercero del 4x1000.
     * Bancolombia se auto-resuelve desde SIIGO_BENEFICIARIO_BANCOLOMBIA_ID;
     * para otros canales, lo elige el operario en el modal.
     */
    bancoBeneficiarioId: z.string().min(1).optional().nullable(),
    /** Pago en efectivo del socio. */
    viaSocio: z.boolean().optional(),
    /** Idempotencia: UUID que genera la pantalla al abrir el formulario. */
    claveIdempotencia: claveIdempotenciaSchema.optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.aplicaciones.length > 0 && v.facturaProveedorIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["aplicaciones"],
        message: "Envía `aplicaciones` o `facturaProveedorIds`, no los dos",
      });
    }
    if ((v.aplicaciones.length > 0 || v.facturaProveedorIds.length > 0) && v.valor <= 0n) {
      ctx.addIssue({
        code: "custom",
        path: ["valor"],
        message: "Un pago que cubre facturas debe tener valor mayor que cero",
      });
    }
  });

const booleanoQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

export const listarPagosQuerySchema = z.object({
  clienteId: z.string().min(1).optional(),
  tramiteId: z.string().min(1).optional(),
  canalPago: z.nativeEnum(CanalPago).optional(),
  /** Alias heredado de `soloSinFecha` (`solo_pendientes`). */
  soloPendientes: booleanoQuery,
  /** Pagos sin fecha real de pago. */
  soloSinFecha: booleanoQuery,
  /** Filtro por proveedor (empresa). */
  proveedorEmpresaId: z.string().min(1).optional(),
  /** Filtro por proveedor (ficha de pago). */
  beneficiarioId: z.string().min(1).optional(),
});

export const actualizarPagoSchema = z.object({
  canalPago: z.nativeEnum(CanalPago).optional(),
  valor: dineroNoNegativoSchema.optional(),
  concepto: z.string().trim().min(1).optional(),
  /** Si se provee, reemplaza todos los beneficiarios vinculados al pago. */
  beneficiarioIds: z.array(z.string().min(1)).optional(),
  numSoporte: z.string().trim().min(1).optional().nullable(),
  fechaRealPago: fechaCalendarioOpcionalSchema,
  /** Banco (Beneficiario) usado como tercero del 4x1000. Null = limpia. */
  bancoBeneficiarioId: z.string().min(1).optional().nullable(),
  /** Comprobante bancario. Null = limpia (no permitido en un bloque no histórico). */
  documentoId: z.string().min(1).optional().nullable(),
  /** Comprobante de la página del comercio (puerto/PSE). Null = limpia. */
  comprobanteComercioId: z.string().min(1).optional().nullable(),
});

export const verificarMovimientoSchema = z.object({
  estado: z.nativeEnum(EstadoMovimiento),
});

// ─── Pago en bloque (multi-DO) ─────────────────────────────────────────────────

export const costoAsumidoPorSchema = z.enum(["GALCOMEX", "PRIMER_DO", "PRORRATEADO"]);

export const crearPagoMultiDOSchema = z.object({
  beneficiarioId: z.string().min(1, "Selecciona el beneficiario"),
  facturas: z
    .array(
      z.object({
        facturaProveedorId: z.string().min(1),
        monto: dineroPositivoSchema,
      }),
    )
    .min(1, "Selecciona al menos una factura"),
  canalPago: z.nativeEnum(CanalPago),
  fechaRealPago: fechaCalendarioOpcionalSchema,
  concepto: z.string().trim().min(1).optional(),
  /** Comprobante bancario: obligatorio salvo registro histórico (lo valida el servicio). */
  documentoId: z.string().min(1).optional().nullable(),
  comprobanteComercioId: z.string().min(1).optional().nullable(),
  bancoBeneficiarioId: z.string().min(1).optional().nullable(),
  /** Lo que salió del banco (informativo). */
  valorTransferido: dineroNoNegativoSchema.optional().nullable(),
  /** Quién asume el costo de la transferencia; sin él, la regla por defecto (D-1). */
  costoAsumidoPor: costoAsumidoPorSchema.optional(),
  /** Registro histórico de conciliación (solo ADMIN). */
  esHistorico: z.boolean().optional().default(false),
  claveIdempotencia: claveIdempotenciaSchema.optional().nullable(),
});

export const listarFacturasElegiblesMultiDOQuerySchema = z
  .object({
    beneficiarioId: z.string().min(1).optional(),
    empresaId: z.string().min(1).optional(),
  })
  .refine((v) => v.beneficiarioId !== undefined || v.empresaId !== undefined, {
    message: "beneficiarioId o empresaId es requerido",
    path: ["beneficiarioId"],
  });

/** PATCH /api/pagos/grupos/[id]: lo que es de la transferencia (se propaga a todo el bloque). */
export const actualizarPagoGrupoSchema = z.object({
  concepto: z.string().trim().min(1).optional(),
  fechaRealPago: fechaCalendarioOpcionalSchema,
  documentoId: z.string().min(1).optional().nullable(),
  comprobanteComercioId: z.string().min(1).optional().nullable(),
  valorTransferido: dineroNoNegativoSchema.optional().nullable(),
});

/** POST /api/pagos/grupos/[id]/anular (solo ADMIN). */
export const anularPagoGrupoSchema = z.object({ motivo: motivoSchema });

/** DELETE /api/facturas-proveedor/[id]/ajustes/[ajusteId] (solo ADMIN, solo LEGADO). */
export const eliminarAjusteLegadoSchema = z.object({ motivo: motivoSchema });

/**
 * POST /api/facturas-proveedor/[id]/generar-pago (CxP v2). Reemplaza en la ruta
 * a `generarPagoDesdeFacturaSchema` de `validations/facturas-proveedor.ts`
 * (archivo de P2): agrega `monto` (abono) y el comprobante.
 */
export const generarPagoDesdeFacturaSchema = z.object({
  canalPago: z.nativeEnum(CanalPago),
  viaSocio: z.boolean().default(false),
  fechaRealPago: fechaCalendarioOpcionalSchema,
  /** Abono: cuánto pagar. Por defecto, todo el saldo. */
  monto: dineroPositivoSchema.optional(),
  documentoId: z.string().min(1).optional().nullable(),
  claveIdempotencia: claveIdempotenciaSchema.optional().nullable(),
});
