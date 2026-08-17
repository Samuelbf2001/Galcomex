import { CanalPago, EstadoMovimiento } from "@prisma/client";
import { z } from "zod";

import { esDecimalValido } from "@/lib/pagos/divisa";

/**
 * Campos de divisa (A2, reunión 1-jul-2026): o los tres vienen juntos, o
 * ninguno. Se comparte entre crearPagoSchema y actualizarPagoSchema para no
 * duplicar el refine. Duplica en Zod la regla que también aplica el servicio
 * (`camposDivisaValidos`) — el servicio es quien tiene la última palabra
 * porque valida contra el estado ya persistido en un PATCH parcial.
 */
const camposDivisaShape = {
  /** "USD", "EUR"… null/ausente = pago en COP puro (caso normal). */
  moneda: z.string().trim().min(1).max(10).optional().nullable(),
  /** Monto en la divisa, en centavos (BigInt) — nunca flotante. */
  valorDivisa: z.coerce
    .bigint()
    .refine((v) => v > 0n, { message: "valorDivisa debe ser mayor a 0" })
    .optional()
    .nullable(),
  /** TRM aplicada, decimal como string para no perder precisión. */
  tasaCambio: z
    .string()
    .trim()
    .min(1)
    .refine(esDecimalValido, { message: "tasaCambio debe ser un decimal válido (ej. '4200.50')" })
    .optional()
    .nullable(),
};

function validarTodoONadaDivisa(
  data: { moneda?: string | null; valorDivisa?: bigint | null; tasaCambio?: string | null },
  ctx: z.RefinementCtx,
) {
  const presentes = [data.moneda, data.valorDivisa, data.tasaCambio].filter(
    (v) => v !== undefined && v !== null,
  ).length;
  if (presentes !== 0 && presentes !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "moneda, valorDivisa y tasaCambio deben venir los tres juntos o ninguno (nunca parcial).",
      path: ["moneda"],
    });
  }
}

export const crearPagoSchema = z
  .object({
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
    /**
     * Banco (Beneficiario) usado como tercero del 4x1000.
     * Bancolombia se auto-resuelve desde SIIGO_BENEFICIARIO_BANCOLOMBIA_ID;
     * para otros canales, lo elige el operario en el modal.
     */
    bancoBeneficiarioId: z.string().min(1).optional().nullable(),
    /**
     * Confirmación explícita de que el usuario aceptó la desviación
     * pago↔facturas (A1, reunión 1-jul-2026). Sin este flag, el servicio
     * rechaza con 422 si el valor se desvía más del umbral configurado
     * (`UMBRAL_DESVIACION_PAGO_PCT`) respecto a la suma de facturas vinculadas.
     */
    confirmarDesviacion: z.boolean().optional().default(false),
    ...camposDivisaShape,
  })
  .superRefine(validarTodoONadaDivisa);

export const listarPagosQuerySchema = z.object({
  clienteId: z.string().min(1).optional(),
  tramiteId: z.string().min(1).optional(),
  canalPago: z.nativeEnum(CanalPago).optional(),
  soloPendientes: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export const actualizarPagoSchema = z
  .object({
    canalPago: z.nativeEnum(CanalPago).optional(),
    valor: z.coerce
      .bigint()
      .refine((v) => v >= 0n, { message: "El valor no puede ser negativo" })
      .optional(),
    concepto: z.string().trim().min(1).optional(),
    /** Si se provee, reemplaza todos los beneficiarios vinculados al pago. */
    beneficiarioIds: z.array(z.string().min(1)).optional(),
    numSoporte: z.string().trim().min(1).optional().nullable(),
    documentoId: z.string().min(1).optional().nullable(),
    fechaRealPago: z.coerce.date().optional().nullable(),
    /** Banco (Beneficiario) usado como tercero del 4x1000. Null = limpia. */
    bancoBeneficiarioId: z.string().min(1).optional().nullable(),
    ...camposDivisaShape,
  })
  .superRefine((data, ctx) => {
    // Esta comprobación es solo la mitad de la regla: como es un PATCH parcial,
    // aquí únicamente se rechaza una mezcla explícita de valores y null dentro
    // de LA MISMA petición (p.ej. mandar moneda:"USD" y valorDivisa:null a la
    // vez es absurdo sin importar qué haya en BD). El chequeo completo
    // (fusionando con el registro persistido) lo hace el servicio — solo él
    // sabe si un campo omitido ya tenía valor en BD.
    const presentesConValor = [data.moneda, data.valorDivisa, data.tasaCambio].filter(
      (v) => v !== undefined && v !== null,
    ).length;
    const presentesExplicitosNull = [
      data.moneda === null,
      data.valorDivisa === null,
      data.tasaCambio === null,
    ].filter(Boolean).length;
    // Si se envía un null explícito, los otros dos campos enviados en la misma
    // petición no pueden tener valor real (mezcla contradictoria).
    if (presentesExplicitosNull > 0 && presentesConValor > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "No se puede limpiar solo parte de los campos de divisa (moneda/valorDivisa/tasaCambio) en la misma petición.",
        path: ["moneda"],
      });
    }
  });

export const verificarMovimientoSchema = z.object({
  estado: z.nativeEnum(EstadoMovimiento),
});
