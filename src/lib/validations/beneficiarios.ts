import { z } from "zod";

export const crearBeneficiarioSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  nit: z.string().trim().min(1).optional().nullable(),
  banco: z.string().trim().min(1).optional().nullable(),
  numCuenta: z.string().trim().min(1).optional().nullable(),
});

export const actualizarBeneficiarioSchema = z.object({
  nombre: z.string().trim().min(1).optional(),
  nit: z.string().trim().min(1).optional().nullable(),
  banco: z.string().trim().min(1).optional().nullable(),
  numCuenta: z.string().trim().min(1).optional().nullable(),
});
