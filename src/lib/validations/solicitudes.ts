import { AgenciaAduanas, Ciudad } from "@prisma/client";
import { z } from "zod";

export const solicitudExternaSchema = z.object({
  nit: z.string().trim().min(1, "El NIT es obligatorio"),
  ciudad: z.nativeEnum(Ciudad),
  agenciaAduanas: z.nativeEnum(AgenciaAduanas),
  proveedorCliente: z.string().trim().min(1).max(200).optional().nullable(),
  eta: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v ? new Date(v) : null)),
  comentarios: z.string().trim().max(1000).optional().nullable(),
});

export type SolicitudExternaInput = z.infer<typeof solicitudExternaSchema>;
