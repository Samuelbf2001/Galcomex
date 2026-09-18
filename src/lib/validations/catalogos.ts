import { TipoCalculoTarifa, UnidadTarifa } from "@prisma/client";
import { z } from "zod";

// ─── Conceptos de venta ───────────────────────────────────────────────────────

/**
 * Campos SIN `.default()`: en Zod 4 `.partial()` conserva los defaults y una
 * edición parcial reescribiría los campos que el usuario no tocó (mismo
 * problema que ya se corrigió en `validations/tarifas.ts`).
 */
const conceptoCampos = {
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(160),
  descripcion: z.string().trim().max(500).optional().nullable(),
  /** Id del producto Siigo (UUID que asigna Siigo). `null` lo desasocia. */
  siigoProductoId: z.string().trim().min(1).max(60).optional().nullable(),
  aplicaIva: z.boolean(),
  tipoCalculoSugerido: z.nativeEnum(TipoCalculoTarifa).optional().nullable(),
  unidadSugerida: z.nativeEnum(UnidadTarifa).optional().nullable(),
  orden: z.number().int().min(0).max(9_999),
  activo: z.boolean(),
  notas: z.string().trim().max(500).optional().nullable(),
};

export const codigoConceptoSchema = z
  .string()
  .trim()
  .min(1, "El código es obligatorio")
  .max(60)
  .regex(/^[A-Z0-9_]+$/, "Usa MAYÚSCULAS, números y guion bajo (p. ej. GASTOS_TRAMITE)");

export const conceptoVentaCrearSchema = z.object({
  codigo: codigoConceptoSchema,
  ...conceptoCampos,
  aplicaIva: conceptoCampos.aplicaIva.default(true),
  orden: conceptoCampos.orden.default(0),
  activo: conceptoCampos.activo.default(true),
});

/** PATCH de la colección: `{ id, ...campos }`. El `codigo` NUNCA se cambia. */
export const conceptoVentaActualizarSchema = z
  .object({
    id: z.string().trim().min(1, "Indica el concepto a editar"),
    ...conceptoCampos,
  })
  .partial()
  .required({ id: true })
  .refine((v) => Object.keys(v).length > 1, {
    message: "No hay nada que cambiar",
  });

export type ConceptoVentaCrearPayload = z.infer<typeof conceptoVentaCrearSchema>;
export type ConceptoVentaActualizarPayload = z.infer<typeof conceptoVentaActualizarSchema>;

// ─── Eventos del catálogo ─────────────────────────────────────────────────────

const eventoCampos = {
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(160),
  descripcion: z.string().trim().max(600).optional().nullable(),
  /** Etiquetas de los documentos que el evento exige en el checklist del DO. */
  documentosRequeridos: z.array(z.string().trim().min(1).max(160)).max(20),
  permiteCantidad: z.boolean(),
  orden: z.number().int().min(0).max(9_999),
  activo: z.boolean(),
};

/**
 * PATCH de la colección: `{ codigo, ...campos }`. El `codigo` identifica y es
 * INMUTABLE: es la FK de `tarifa_item.eventoCodigo` y `tramite_evento`.
 */
export const eventoCatalogoActualizarSchema = z
  .object({
    codigo: z.string().trim().min(1, "Indica el evento a editar").max(60),
    ...eventoCampos,
  })
  .partial()
  .required({ codigo: true })
  .refine((v) => Object.keys(v).length > 1, {
    message: "No hay nada que cambiar",
  });

export type EventoCatalogoActualizarPayload = z.infer<typeof eventoCatalogoActualizarSchema>;
