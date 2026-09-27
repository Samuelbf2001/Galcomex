import { z } from "zod";

/**
 * NIT de la ficha de pago (CxP v2, D.6): la pantalla pide el NIT **sin** dígito
 * de verificación y el DV en un campo aparte. Por compatibilidad (MCP, scripts)
 * también se acepta el NIT con el DV pegado con guion ("800154017-8"); el
 * servicio valida el DV con el algoritmo DIAN y guarda siempre "base-DV".
 */
const dvSchema = z
  .union([z.string().trim(), z.number().int()])
  .transform((v) => String(v).trim())
  .refine((v) => v === "" || /^\d$/.test(v), { message: "El DV es un solo dígito (0 a 9)" })
  .transform((v) => (v === "" ? null : Number(v)));

const campos = {
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  /** NIT sin DV (o con el DV pegado con guion). Cédulas y extranjeros: sin DV. */
  nit: z.string().trim().min(1).optional().nullable(),
  /** Dígito de verificación (opcional). Si viene y no cuadra → `NIT_DV_INVALIDO`. */
  dv: dvSchema.optional().nullable(),
  banco: z.string().trim().min(1).optional().nullable(),
  numCuenta: z.string().trim().min(1).optional().nullable(),
  /**
   * Ficha de empresa a la que corresponde este beneficiario (M5). Es el puente
   * que permite cruzar en una sola cuenta corriente lo que se le paga como
   * proveedor y lo que nos debe como cliente. Si se indica, su NIT debe ser el
   * de la empresa (`NIT_NO_COINCIDE_EMPRESA`).
   */
  empresaId: z.string().min(1).optional().nullable(),
  /** Nombre como sale en la línea de terceros de la factura de venta ("ALMACARGA"). */
  nombreCorto: z.string().trim().max(60).optional().nullable(),
  /** "Numerar sus facturas como FE 11298" en la factura de venta. */
  numFacturaConEspacio: z.boolean().optional(),
  /** Reenvío tras `POSIBLE_BENEFICIARIO_DUPLICADO` ("Es otra, crearla"). */
  confirmarOtraFicha: z.boolean().optional(),
  /**
   * Solo ADMIN: crear otra ficha con el MISMO NIT (otra cuenta bancaria del
   * mismo proveedor) pese a `BENEFICIARIO_EXISTE`.
   */
  otraCuentaMismoProveedor: z.boolean().optional(),
};

export const crearBeneficiarioSchema = z.object(campos);

export const actualizarBeneficiarioSchema = z.object({
  ...campos,
  nombre: campos.nombre.optional(),
});
