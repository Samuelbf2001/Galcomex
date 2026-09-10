import { z } from "zod";

export const crearBeneficiarioSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  nit: z.string().trim().min(1).optional().nullable(),
  banco: z.string().trim().min(1).optional().nullable(),
  numCuenta: z.string().trim().min(1).optional().nullable(),
  /**
   * Ficha de empresa a la que corresponde este beneficiario (M5). Es el puente
   * que permite cruzar en una sola cuenta corriente lo que se le paga como
   * proveedor y lo que nos debe como cliente.
   */
  empresaId: z.string().min(1).optional().nullable(),
});

export const actualizarBeneficiarioSchema = z.object({
  nombre: z.string().trim().min(1).optional(),
  nit: z.string().trim().min(1).optional().nullable(),
  banco: z.string().trim().min(1).optional().nullable(),
  numCuenta: z.string().trim().min(1).optional().nullable(),
  empresaId: z.string().min(1).optional().nullable(),
});
