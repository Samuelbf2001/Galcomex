import {
  Ciudad,
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
  /** B6 — ESPEJO_DE_COSTO "por proveedor": NIT base (solo dígitos, sin DV ni puntos). */
  nitProveedorCosto: z
    .string()
    .trim()
    .regex(/^[0-9]{6,12}$/,"Escribe el NIT sin dígito de verificación ni puntos (ej. 830115297)")
    .optional()
    .nullable(),
  /** B6 — ESPEJO_DE_COSTO "por proveedor": código del producto Siigo de esas facturas (opcional). */
  productoCosto: z.string().trim().min(1).max(20).optional().nullable(),
  tramos: tramosTarifaSchema.optional().nullable(),
  aplicaIva: z.boolean(),
  notas: z.string().trim().max(500).optional().nullable(),
  orden: z.number().int().min(0).max(9_999),
  /** B1 — "restar el agenciamiento de la agencia de aduanas del DO" (una vez por DO). */
  restaAgenciamiento: z.boolean(),
  /** B1 — solo con `restaAgenciamiento` y PORCENTAJE_MIN: mínimo NETO (false) o TOTAL (true). */
  minimoEsDelTotal: z.boolean(),
};

const tarifaItemBase = z.object({
  ...tarifaItemCampos,
  disparador: tarifaItemCampos.disparador.default(DisparadorTarifa.SIEMPRE),
  unidad: tarifaItemCampos.unidad.default(UnidadTarifa.TRAMITE),
  valor: tarifaItemCampos.valor.default(0n),
  aplicaIva: tarifaItemCampos.aplicaIva.default(true),
  orden: tarifaItemCampos.orden.default(0),
  restaAgenciamiento: tarifaItemCampos.restaAgenciamiento.default(false),
  minimoEsDelTotal: tarifaItemCampos.minimoEsDelTotal.default(false),
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
  if (
    item.tipoCalculo === TipoCalculoTarifa.ESPEJO_DE_COSTO &&
    !item.conceptoCosto &&
    !item.nitProveedorCosto &&
    !item.productoCosto
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["conceptoCosto"],
      message: "Indica qué pago o factura de proveedor se espeja (un texto, o el NIT del proveedor)",
    });
  }
  // B6 — el modo "por proveedor" solo existe en «Lo mismo que costó».
  if (item.tipoCalculo !== TipoCalculoTarifa.ESPEJO_DE_COSTO && (item.nitProveedorCosto || item.productoCosto)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [item.nitProveedorCosto ? "nitProveedorCosto" : "productoCosto"],
      message: "El proveedor y el producto del costo solo aplican a «Lo mismo que costó»",
    });
  }
  // B6 — cobra por cada pago del proveedor: necesita saber cuántos registros hubo (evento) o cobrar siempre.
  if (
    item.tipoCalculo === TipoCalculoTarifa.ESPEJO_DE_COSTO &&
    (item.nitProveedorCosto || item.productoCosto) &&
    item.disparador === DisparadorTarifa.MANUAL
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["disparador"],
      message: "Un ítem que espeja lo pagado a un proveedor no puede ser manual: usa un evento o «siempre»",
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
  // B1 — "restar el agenciamiento" (una vez por DO, ver resta-agenciamiento.ts).
  if (item.restaAgenciamiento && item.disparador === DisparadorTarifa.MANUAL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["restaAgenciamiento"],
      message: "Un ítem manual no resta la agencia: el revisor lo escribe a mano",
    });
  }
  if (item.restaAgenciamiento && item.tipoCalculo === TipoCalculoTarifa.ESPEJO_DE_COSTO) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["restaAgenciamiento"],
      message: "Un ítem espejo de costo no resta la agencia",
    });
  }
  if (item.minimoEsDelTotal && !item.restaAgenciamiento) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimoEsDelTotal"],
      message: "El mínimo por el total solo aplica cuando el ítem resta la agencia",
    });
  }
  if (item.minimoEsDelTotal && item.tipoCalculo !== TipoCalculoTarifa.PORCENTAJE_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimoEsDelTotal"],
      message: "El mínimo por el total solo aplica a «% del CIF con mínimo»",
    });
  }
}

export const tarifaItemSchema = tarifaItemBase.superRefine(validarCoherenciaItem);
// Sin defaults: en Zod 4 `.partial()` conserva los `.default()` y una edición
// parcial reescribía disparador, unidad, valor, IVA y orden del ítem.
export const tarifaItemUpdateSchema = z.object(tarifaItemCampos).partial();

const fechaSchema = z.coerce.date();

/** B2 — código del concepto de venta (MAYÚSCULAS, dígitos y guion bajo). Vacío/nulo = sin servicio. */
const conceptoServicioSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Z0-9_]+$/, "Usa el código del concepto en MAYÚSCULAS (p. ej. NACIONALIZACION_ZF)")
  .optional()
  .nullable();

/** B3 — ciudades a las que aplica el tarifario. Vacío = general. Máx. 5 (una por ciudad del enum), sin repetidos. */
const ciudadesSchema = z
  .array(z.nativeEnum(Ciudad))
  .max(5)
  .refine((c) => new Set(c).size === c.length, { message: "Hay una ciudad repetida" });

export const tarifarioSchema = z
  .object({
    /** Código de plantilla (ver `lib/tarifas/plantillas.ts`): rellena nombre, alcance e ítems si no vienen. */
    plantilla: z.string().trim().min(1).max(60).optional(),
    /** Tarifario existente (de cualquier empresa) del que copiar los ítems (B2, "Copiar la tarifa de otra empresa"). */
    origenTarifarioId: z.string().trim().min(1).max(60).optional(),
    nombre: z.string().trim().min(1, "El nombre es obligatorio").max(120).optional(),
    alcance: z.enum(ALCANCES_TARIFARIO).optional(),
    /**
     * B3 — vacío = general (cualquier ciudad sin tarifario propio). SIN
     * default: `crearTarifario` lo trata como `[]`, pero `crearTarifarioDesde`
     * (`origenTarifarioId`) necesita distinguir "no vino" de "vino vacío" para
     * copiar las ciudades del origen (R4).
     */
    ciudades: ciudadesSchema.optional(),
    /**
     * Servicio (código del concepto de venta) que cobra la tarifa. B2: en
     * «Otros servicios» es obligatorio (sin los servicios de un trámite
     * normal). 30-sep-2026: en «Trámites» es opcional (vacío = tarifa general;
     * TRASLADO_ZF, NACIONALIZACION_ZF o DUTA); en los demás, vacío. Lo valida
     * el servicio (`reglaServicioDeAlcance`), que conoce el catálogo.
     */
    conceptoServicioCodigo: conceptoServicioSchema,
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
  })
  .superRefine((t, ctx) => {
    // B1 — la agencia se resta una sola vez por DO: como máximo un ítem con la casilla.
    const conResta = t.items.filter((i) => i.restaAgenciamiento);
    if (conResta.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "La agencia se resta una sola vez por DO",
      });
    }
  });

export const tarifarioUpdateSchema = z
  .object({
    nombre: z.string().trim().min(1).max(120).optional(),
    alcance: z.enum(ALCANCES_TARIFARIO).optional(),
    /** B3 — solo se edita en BORRADOR (el servicio lo exige). */
    ciudades: ciudadesSchema.optional(),
    /** B2 — servicio de «Otros»; solo se edita en BORRADOR (igual que alcance y ciudades). */
    conceptoServicioCodigo: conceptoServicioSchema,
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
    /** B3 — si no viene, `duplicarTarifario` copia las ciudades del origen. */
    ciudades: ciudadesSchema.optional(),
    /** B2 — si no viene, se copia el servicio del origen; `null` lo quita. Así se recarga la DUTA vieja con su servicio. */
    conceptoServicioCodigo: conceptoServicioSchema,
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
