import { TipoCliente } from "@prisma/client";
import { z } from "zod";

export const tipoClienteQuerySchema = z
  .enum(["propio", "socio_lm", "PROPIO", "SOCIO_LM"])
  .optional()
  .transform((tipo) => {
    if (!tipo) {
      return undefined;
    }

    return tipo.toUpperCase() as TipoCliente;
  });

export const tarifaClienteSchema = z.object({
  anio: z.number().int().min(2020).max(2100),
  tipo: z.enum(["por_contenedor", "fijo", "porcentaje_cif"]),
  valor: z.coerce.bigint().refine((valor) => valor >= 0n, {
    message: "La tarifa no puede ser negativa",
  }),
});

export const clientePayloadSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  nit: z.string().trim().min(1, "El NIT es obligatorio"),
  tipo: z.nativeEnum(TipoCliente).default(TipoCliente.PROPIO),
  contactoNombre: z.string().trim().min(1).optional().nullable(),
  contactoEmail: z.string().trim().email().optional().nullable(),
  contactoTel: z.string().trim().min(1).optional().nullable(),
  manejaAnticipo: z.boolean().default(true),
  activo: z.boolean().default(true),
  tarifas: z.array(tarifaClienteSchema).default([]),
});

export const clienteUpdateSchema = clientePayloadSchema.partial().extend({
  tarifas: z.array(tarifaClienteSchema).optional(),
});
