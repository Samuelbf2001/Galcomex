import {
  DisparadorTarifa,
  TipoCalculoTarifa,
  UnidadTarifa,
} from "@prisma/client";
import { z } from "zod";

import {
  centavosDeTexto,
  dineroNoNegativoSchema,
  textoCanonicoDeCentavos,
  textoDeCentavos,
  type Centavos,
} from "@/lib/dinero";

/**
 * Fase centavos (diseño A.2 / B.4):
 *   - `valor` / `valorAdicional` llegan en PESOS (texto "100000" o "100000.50",
 *     o number) y salen del esquema en CENTAVOS (bigint).
 *   - `minimos` y `tramos[].valor` son JSON guardados en PESOS texto: se
 *     validan con `centavosDeTexto` (máx. 2 decimales, sin separador de miles)
 *     y salen en forma CANÓNICA ("300000", "300000.45"; nunca "300000.00"),
 *     que es como se guardan.
 */
const cop = dineroNoNegativoSchema;

/** PESOS texto para los JSON de mínimos y tramos → texto canónico. */
const copString = z
  .string()
  .trim()
  .transform((s, ctx): string => {
    let c: Centavos;
    try {
      c = centavosDeTexto(s);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: 'Escribe el valor en pesos, con punto decimal si lleva centavos y sin separador de miles (ej. "300000" o "300000.50")',
      });
      return z.NEVER;
    }
    if (c < 0n) {
      ctx.addIssue({ code: "custom", message: "El valor no puede ser negativo" });
      return z.NEVER;
    }
    return textoCanonicoDeCentavos(c);
  });

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

/** Campos de un ítem SIN valores por defecto (base de la edición parcial). */
const tarifaItemCampos = {
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
  disparador: z.nativeEnum(DisparadorTarifa),
  eventoCodigo: z.string().trim().min(1).max(60).optional().nullable(),
  unidad: z.nativeEnum(UnidadTarifa),
  valor: cop,
  valorAdicional: cop.optional().nullable(),
  /** Puntos básicos: 37 = 0,37 %. */
  porcentajeBps: z.number().int().min(1).max(100_000).optional().nullable(),
  minimos: minimosTarifaSchema.optional().nullable(),
  conceptoCosto: z.string().trim().min(1).max(120).optional().nullable(),
  tramos: tramosTarifaSchema.optional().nullable(),
  aplicaIva: z.boolean(),
  notas: z.string().trim().max(500).optional().nullable(),
  orden: z.number().int().min(0).max(9_999),
};

const tarifaItemBase = z.object({
  ...tarifaItemCampos,
  disparador: tarifaItemCampos.disparador.default(DisparadorTarifa.SIEMPRE),
  unidad: tarifaItemCampos.unidad.default(UnidadTarifa.TRAMITE),
  // Zod 4: `.default()` devuelve el valor tal cual (tipo de SALIDA): 0n centavos.
  valor: tarifaItemCampos.valor.default(0n),
  aplicaIva: tarifaItemCampos.aplicaIva.default(true),
  orden: tarifaItemCampos.orden.default(0),
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

/**
 * Ítem ya validado (valores en CENTAVOS) → forma de ENTRADA del esquema
 * (PESOS texto), para volver a validarlo (plantillas, edición parcial). El
 * esquema no acepta `bigint` de entrada: sería ambiguo pesos/centavos.
 * Ida y vuelta exacta: `tarifaItemSchema.parse(entradaDeItemTarifa(it)).valor === it.valor`.
 */
export function entradaDeItemTarifa<T extends { valor?: Centavos; valorAdicional?: Centavos | null }>(
  item: T,
): Omit<T, "valor" | "valorAdicional"> & { valor?: string; valorAdicional?: string | null } {
  const { valor, valorAdicional, ...resto } = item;
  return {
    ...resto,
    ...(valor !== undefined ? { valor: textoDeCentavos(valor) } : {}),
    ...(valorAdicional !== undefined
      ? { valorAdicional: valorAdicional === null ? null : textoDeCentavos(valorAdicional) }
      : {}),
  };
}
// Sin defaults: en Zod 4 `.partial()` conserva los `.default()` y una edición
// parcial reescribía disparador, unidad, valor, IVA y orden del ítem.
export const tarifaItemUpdateSchema = z.object(tarifaItemCampos).partial();

const fechaSchema = z.coerce.date();

export const tarifarioSchema = z
  .object({
    /** Código de plantilla (ver `lib/tarifas/plantillas.ts`): rellena nombre, alcance e ítems si no vienen. */
    plantilla: z.string().trim().min(1).max(60).optional(),
    /** Tarifario existente (de cualquier empresa) del que copiar los ítems (B2, "Copiar la tarifa de otra empresa"). */
    origenTarifarioId: z.string().trim().min(1).max(60).optional(),
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
  })
  .refine((t) => !(t.plantilla && t.origenTarifarioId), {
    path: ["origenTarifarioId"],
    message: "Elige una plantilla o un tarifario de origen, no los dos a la vez",
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
    /**
     * Paso de redondeo en PESOS enteros (1.000 por defecto), NO centavos: el
     * servicio lo convierte con `pesos(redondeoA)` antes de operar (A.2).
     */
    redondeoA: z.number().int().min(1).max(1_000_000).default(1_000),
    /** Copiar a otra empresa (arrancar el tarifario de un cliente nuevo desde uno existente). */
    empresaDestinoId: z.string().min(1).optional(),
  })
  .refine((t) => t.vigenteHasta >= t.vigenteDesde, {
    path: ["vigenteHasta"],
    message: "La vigencia termina antes de empezar",
  });

/** Query de `GET /api/tarifarios` (catálogo ligero para "Copiar la tarifa de otra empresa", B2). */
export const tarifariosListQuerySchema = z.object({
  /** Empresa a excluir del listado (la que está armando su tarifario nuevo). */
  excluirEmpresaId: z.string().trim().min(1).max(60).optional(),
});

export type TarifarioPayload = z.infer<typeof tarifarioSchema>;
export type TarifariosListQuery = z.infer<typeof tarifariosListQuerySchema>;
export type TarifarioUpdatePayload = z.infer<typeof tarifarioUpdateSchema>;
export type TarifarioDuplicarPayload = z.infer<typeof tarifarioDuplicarSchema>;
export type TarifaItemPayload = z.infer<typeof tarifaItemSchema>;
export type TarifaItemUpdatePayload = z.infer<typeof tarifaItemUpdateSchema>;
