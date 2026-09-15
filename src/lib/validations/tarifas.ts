import {
  DisparadorTarifa,
  TipoCalculoTarifa,
  UnidadTarifa,
} from "@prisma/client";
import { z } from "zod";

const cop = z.coerce
  .bigint()
  .refine((v) => v >= 0n, { message: "El valor no puede ser negativo" });

/** COP como string de dígitos (así viaja el JSON de mínimos). */
const copString = z
  .string()
  .trim()
  .regex(/^\d{1,15}$/, "Escribe el valor en pesos sin puntos ni decimales");

export const minimosTarifaSchema = z
  .object({
    SUELTA: copString.optional(),
    CONTENEDOR_20: copString.optional(),
    CONTENEDOR_40: copString.optional(),
  })
  .strict();

/**
 * Tramos de un ítem POR_TRAMO. `hasta` inclusive; `null` = "en adelante".
 * Polyrec ZF: `[{ hasta: 1, valor: "300000" }, { hasta: null, valor: "250000" }]`.
 */
export const tramosTarifaSchema = z
  .array(
    z
      .object({
        hasta: z.number().int().min(1).max(100_000).nullable(),
        valor: copString,
      })
      .strict(),
  )
  .min(1, "Un ítem por tramos necesita al menos un tramo")
  .max(20)
  .superRefine((tramos, ctx) => {
    const abiertos = tramos.filter((t) => t.hasta === null).length;
    if (abiertos > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Solo puede haber un tramo abierto (en adelante)" });
    }
    const topes = tramos.filter((t) => t.hasta !== null).map((t) => t.hasta as number);
    if (new Set(topes).size !== topes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Dos tramos terminan en la misma cantidad" });
    }
  });

export type TramosTarifaInput = z.infer<typeof tramosTarifaSchema>;

export const ALCANCES_TARIFARIO = [
  "TRAMITE",
  "CLASIFICACION",
  "PLAN_VALLEJO",
  "EXPORTACION",
  "OTROS",
] as const;

const tarifaItemBase = z.object({
  /** Código estable del concepto: GASTOS_TRAMITE, SISTEMATIZACION… */
  concepto: z
    .string()
    .trim()
    .min(1, "El concepto es obligatorio")
    .max(60)
    .regex(/^[A-Z0-9_]+$/, "Usa MAYÚSCULAS, números y guion bajo (p. ej. GASTOS_TRAMITE)"),
  nombrePublico: z.string().trim().min(1, "El nombre público es obligatorio").max(160),
  siigoCodigo: z.string().trim().min(1).max(20).optional().nullable(),
  tipoCalculo: z.nativeEnum(TipoCalculoTarifa),
  disparador: z.nativeEnum(DisparadorTarifa).default(DisparadorTarifa.SIEMPRE),
  eventoCodigo: z.string().trim().min(1).max(60).optional().nullable(),
  unidad: z.nativeEnum(UnidadTarifa).default(UnidadTarifa.TRAMITE),
  valor: cop.default(0n),
  valorAdicional: cop.optional().nullable(),
  /** Puntos básicos: 37 = 0,37 %. */
  porcentajeBps: z.number().int().min(1).max(100_000).optional().nullable(),
  minimos: minimosTarifaSchema.optional().nullable(),
  conceptoCosto: z.string().trim().min(1).max(120).optional().nullable(),
  tramos: tramosTarifaSchema.optional().nullable(),
  aplicaIva: z.boolean().default(true),
  notas: z.string().trim().max(500).optional().nullable(),
  orden: z.number().int().min(0).max(9_999).default(0),
});

export type TarifaItemInput = z.infer<typeof tarifaItemBase>;

/** Coherencia entre tipo de cálculo y los campos que necesita. */
export function validarCoherenciaItem(item: TarifaItemInput, ctx: z.RefinementCtx) {
  if (item.disparador === DisparadorTarifa.EVENTO && !item.eventoCodigo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eventoCodigo"],
      message: "Un ítem por evento necesita el evento que lo dispara",
    });
  }
  if (item.tipoCalculo === TipoCalculoTarifa.PORCENTAJE_MIN && !item.porcentajeBps) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["porcentajeBps"],
      message: "Indica el porcentaje sobre el CIF (en puntos básicos: 37 = 0,37 %)",
    });
  }
  if (item.tipoCalculo === TipoCalculoTarifa.ESPEJO_DE_COSTO && !item.conceptoCosto) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["conceptoCosto"],
      message: "Indica qué pago o factura de proveedor se espeja",
    });
  }
  if (item.tipoCalculo === TipoCalculoTarifa.POR_TRAMO && (!item.tramos || item.tramos.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tramos"],
      message: "Indica los tramos (hasta cuántas unidades y a qué precio cada una)",
    });
  }
  if (
    item.tipoCalculo === TipoCalculoTarifa.PRIMERO_MAS_ADICIONAL &&
    (item.valorAdicional === undefined || item.valorAdicional === null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["valorAdicional"],
      message: "Indica el valor de cada unidad adicional",
    });
  }
  if (
    (item.tipoCalculo === TipoCalculoTarifa.FIJO || item.tipoCalculo === TipoCalculoTarifa.POR_UNIDAD) &&
    item.valor <= 0n
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["valor"],
      message: "El valor debe ser mayor a 0",
    });
  }
}

export const tarifaItemSchema = tarifaItemBase.superRefine(validarCoherenciaItem);
export const tarifaItemUpdateSchema = tarifaItemBase.partial();

const fechaSchema = z.coerce.date();

export const tarifarioSchema = z
  .object({
    /** Código de plantilla (ver `lib/tarifas/plantillas.ts`): rellena nombre, alcance e ítems si no vienen. */
    plantilla: z.string().trim().min(1).max(60).optional(),
    nombre: z.string().trim().min(1, "El nombre es obligatorio").max(120).optional(),
    alcance: z.enum(ALCANCES_TARIFARIO).optional(),
    vigenteDesde: fechaSchema,
    vigenteHasta: fechaSchema,
    notas: z.string().trim().max(1_000).optional().nullable(),
    items: z.array(tarifaItemSchema).default([]),
  })
  .refine((t) => t.vigenteHasta >= t.vigenteDesde, {
    path: ["vigenteHasta"],
    message: "La vigencia termina antes de empezar",
  });

export const tarifarioUpdateSchema = z
  .object({
    nombre: z.string().trim().min(1).max(120).optional(),
    alcance: z.enum(ALCANCES_TARIFARIO).optional(),
    vigenteDesde: fechaSchema.optional(),
    vigenteHasta: fechaSchema.optional(),
    notas: z.string().trim().max(1_000).optional().nullable(),
  })
  .refine((t) => !t.vigenteDesde || !t.vigenteHasta || t.vigenteHasta >= t.vigenteDesde, {
    path: ["vigenteHasta"],
    message: "La vigencia termina antes de empezar",
  });

export const tarifarioEstadoSchema = z.object({
  estado: z.enum(["VIGENTE", "VENCIDO"]),
});

export const tarifarioDuplicarSchema = z
  .object({
    nombre: z.string().trim().min(1).max(120).optional(),
    vigenteDesde: fechaSchema,
    vigenteHasta: fechaSchema,
    /** Incremento porcentual (5.29 = IPC 5,29 %). Se redondea a `redondeoA`. */
    incrementoPct: z.number().min(-100).max(1_000).optional(),
    redondeoA: z.number().int().min(1).max(1_000_000).default(1_000),
    /** Copiar a otra empresa (arrancar el tarifario de un cliente nuevo desde uno existente). */
    empresaDestinoId: z.string().min(1).optional(),
  })
  .refine((t) => t.vigenteHasta >= t.vigenteDesde, {
    path: ["vigenteHasta"],
    message: "La vigencia termina antes de empezar",
  });

export type TarifarioPayload = z.infer<typeof tarifarioSchema>;
export type TarifarioUpdatePayload = z.infer<typeof tarifarioUpdateSchema>;
export type TarifarioDuplicarPayload = z.infer<typeof tarifarioDuplicarSchema>;
export type TarifaItemPayload = z.infer<typeof tarifaItemSchema>;
export type TarifaItemUpdatePayload = z.infer<typeof tarifaItemUpdateSchema>;
