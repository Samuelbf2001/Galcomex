import { CanalPago } from "@prisma/client";
import { z } from "zod";

import { dineroPositivoSchema, trmSchema, usdSchema } from "@/lib/dinero";
import { fechaCalendarioOpcionalSchema, fechaCalendarioSchema, motivoSchema } from "@/lib/validations/comunes";

/*
 * Fase centavos: el dinero llega en PESOS (texto "502801.45" o número) y sale
 * en CENTAVOS (`bigint`). USD: `valorOrigen` en dólares ("131.00") y `trm` en
 * pesos por dólar ("3710.50"); salen como `valorOrigenCentavos` (centavos de
 * USD) y `trmCentavos` (centavos de COP por USD), los nombres del servicio.
 * Las llaves viejas `valorOrigenCentavos`/`trmCentavos` (centavos en texto)
 * ya no se aceptan: se ignoran y la factura USD queda incompleta (error claro).
 */

export const MENSAJE_ARCHIVO_OBLIGATORIO =
  "El archivo de la factura es obligatorio. Solo se puede omitir en un costo propio que no se le cobra al cliente (por ejemplo, la clasificadora).";

export const MENSAJE_NUMERO_SIN_ALFANUMERICOS =
  "El número de factura debe tener al menos una letra o un número.";

export const MENSAJE_USD_INCOMPLETO =
  "Una factura en dólares necesita el valor en dólares y la TRM (ambos mayores que cero).";

export const MENSAJE_COP_CON_USD =
  "Una factura en pesos no lleva valor en dólares ni TRM: cambia la moneda a USD o borra esos campos.";

/** "FE-12481" sí; "---" no (su número normalizado quedaría vacío y escaparía a la llave anti-duplicado). */
const numFacturaSchema = z
  .string()
  .trim()
  .min(1, "El número de factura es obligatorio")
  .refine((v) => /[A-Za-z0-9]/.test(v), { message: MENSAJE_NUMERO_SIN_ALFANUMERICOS });

export const monedaSchema = z.enum(["COP", "USD"]);

type CamposMoneda = {
  moneda?: "COP" | "USD";
  valorOrigen?: bigint | null;
  trm?: bigint | null;
};

/** R14: USD exige valor en dólares y TRM; COP no los admite. */
function validarMoneda(data: CamposMoneda, ctx: z.RefinementCtx, monedaPorDefecto: "COP" | "USD" | undefined) {
  const moneda = data.moneda ?? monedaPorDefecto;
  if (moneda === "USD") {
    if (!data.valorOrigen) {
      ctx.addIssue({ code: "custom", path: ["valorOrigen"], message: MENSAJE_USD_INCOMPLETO });
    }
    if (!data.trm) {
      ctx.addIssue({ code: "custom", path: ["trm"], message: MENSAJE_USD_INCOMPLETO });
    }
  } else if (moneda === "COP") {
    if (data.valorOrigen != null || data.trm != null) {
      ctx.addIssue({ code: "custom", path: ["moneda"], message: MENSAJE_COP_CON_USD });
    }
  }
}

/**
 * Llaves de la API → nombres del servicio: `valorOrigen` → `valorOrigenCentavos`,
 * `trm` → `trmCentavos` (ya en centavos). `undefined` se conserva (PATCH parcial).
 */
function aCamposServicioUsd<T extends { valorOrigen?: bigint | null; trm?: bigint | null }>(
  data: T,
): Omit<T, "valorOrigen" | "trm"> & { valorOrigenCentavos?: bigint | null; trmCentavos?: bigint | null } {
  const { valorOrigen, trm, ...resto } = data;
  return {
    ...resto,
    ...(valorOrigen !== undefined ? { valorOrigenCentavos: valorOrigen } : {}),
    ...(trm !== undefined ? { trmCentavos: trm } : {}),
  };
}

export const crearFacturaProveedorSchema = z
  .object({
    /**
     * Legado: el nombre y el NIT que se guardan salen SIEMPRE de la ficha de
     * pago (`beneficiarioId`). Se aceptan para no romper clientes viejos (MCP).
     */
    proveedorNombre: z.string().trim().min(1).optional(),
    proveedorNit: z.string().trim().min(1).optional().nullable(),
    /**
     * Ficha de pago del proveedor. OBLIGATORIA (R7, CA-02): la exige el
     * servicio con `PROVEEDOR_OBLIGATORIO` (422) para que valga también para
     * scripts y MCP; aquí se deja pasar null/ausente para responder ese código.
     */
    beneficiarioId: z.string().min(1).optional().nullable(),
    concepto: z.string().trim().min(1).optional().nullable(),
    siigoProductoId: z.string().min(1).optional().nullable(),
    numFactura: numFacturaSchema,
    /** Pesos > 0 con hasta 2 decimales ("502801.45"; en USD es el valor en pesos: el que manda y se paga). */
    valor: dineroPositivoSchema,
    /** Fecha-calendario ("YYYY-MM-DD" → 00:00 UTC del día; sin corrimiento por la hora de Bogotá). */
    fecha: fechaCalendarioSchema,
    /**
     * Archivo de la factura. Obligatorio si se le cobra al cliente: es el soporte
     * del ítem de terceros en la factura de venta. En un costo propio (no
     * repercutible) es opcional: la clasificadora no emite factura, solo cobra,
     * y el soporte es el comprobante del pago.
     */
    documentoId: z.string().min(1).optional().nullable(),
    /**
     * ¿Se traslada al cliente en la factura de venta? (M6). Default `true`:
     * el caso normal es que el gasto se pague por cuenta del cliente. En `false`
     * la factura queda en el trámite para pagarla, pero el cliente no la ve.
     */
    repercutible: z.boolean().default(true),
    /** R14 / D-4. Default COP. */
    moneda: monedaSchema.default("COP"),
    /** Solo USD: valor en dólares ("131.00" = USD 131,00). */
    valorOrigen: usdSchema.optional().nullable(),
    /** Solo USD: TRM en pesos por dólar ("3710.50"). */
    trm: trmSchema.optional().nullable(),
    /** Solo USD: fecha-calendario de la TRM. */
    fechaTrm: fechaCalendarioOpcionalSchema,
    /** Reenvío tras `POSIBLE_DUPLICADO` ("Es otra factura, guardar"). */
    confirmarPosibleDuplicado: z.boolean().default(false),
    /** Reenvío tras `USD_VALOR_LEJOS_DE_TRM` ("Sí, guardar"). */
    confirmarValorUsd: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.repercutible && !data.documentoId) {
      ctx.addIssue({ code: "custom", path: ["documentoId"], message: MENSAJE_ARCHIVO_OBLIGATORIO });
    }
    validarMoneda(data, ctx, "COP");
  })
  .transform(aCamposServicioUsd);

/**
 * PATCH: la pantalla manda todos los campos en cada guardado; el servicio
 * compara contra la fila actual y solo aplica R11 a los CAMBIOS REALES.
 * La coherencia de moneda (USD con valor y TRM) la valida el servicio sobre el
 * estado final de la factura (aquí solo se rechaza una combinación explícita
 * imposible: moneda COP junto con valor en dólares o TRM).
 */
export const actualizarFacturaProveedorSchema = z
  .object({
    proveedorNombre: z.string().trim().min(1).optional(),
    proveedorNit: z.string().trim().min(1).optional().nullable(),
    beneficiarioId: z.string().min(1).optional().nullable(),
    concepto: z.string().trim().min(1).optional().nullable(),
    siigoProductoId: z.string().min(1).optional().nullable(),
    numFactura: numFacturaSchema.optional(),
    valor: dineroPositivoSchema.optional(),
    fecha: fechaCalendarioSchema.optional(),
    documentoId: z.string().min(1).optional().nullable(),
    repercutible: z.boolean().optional(),
    moneda: monedaSchema.optional(),
    valorOrigen: usdSchema.optional().nullable(),
    trm: trmSchema.optional().nullable(),
    fechaTrm: fechaCalendarioOpcionalSchema,
    confirmarPosibleDuplicado: z.boolean().optional(),
    confirmarValorUsd: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.moneda === "COP") validarMoneda(data, ctx, undefined);
  })
  .transform(aCamposServicioUsd);

/**
 * Re-expresión del valor en pesos de una factura USD (D-4, solo ADMIN): nueva
 * TRM y nuevo valor en pesos, con motivo. Nunca por debajo de lo ya pagado ni
 * si la factura ya se le cobró al cliente (lo valida el servicio).
 */
export const reexpresarFacturaUsdSchema = z
  .object({
    /** Nuevo valor en pesos ("486075.50"). */
    valor: dineroPositivoSchema,
    /** Nueva TRM en pesos por dólar ("3710.50"). */
    trm: trmSchema,
    fechaTrm: fechaCalendarioOpcionalSchema,
    motivo: motivoSchema,
    confirmarValorUsd: z.boolean().default(false),
  })
  .transform(({ trm, ...resto }) => ({ ...resto, trmCentavos: trm }));

/**
 * "Generar pago" (API/MCP; la ruta y el servicio son de P1). `monto` (abono) y
 * `documentoId` (comprobante) son opcionales: sin `monto` se paga el saldo.
 */
export const generarPagoDesdeFacturaSchema = z.object({
  canalPago: z.nativeEnum(CanalPago),
  viaSocio: z.boolean().default(false),
  fechaRealPago: fechaCalendarioOpcionalSchema,
  monto: dineroPositivoSchema.optional(),
  documentoId: z.string().min(1).optional(),
});

export const solicitarFacturacionSchema = z.object({}).optional();
