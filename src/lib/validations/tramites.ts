import { AgenciaAduanas, Ciudad, EstadoTramite } from "@prisma/client";
import { z } from "zod";

const optionalDate = z
  .string()
  .datetime()
  .optional()
  .nullable()
  .transform((value) => (value ? new Date(value) : null));

export const tramiteCreateSchema = z.object({
  ciudad: z.nativeEnum(Ciudad),
  anio: z.number().int().min(2020).max(2100).optional(),
  clienteId: z.string().min(1, "El cliente es obligatorio"),
  proveedorCliente: z.string().trim().min(1).optional().nullable(),
  agenciaAduanas: z.nativeEnum(AgenciaAduanas),
  doAgencia: z.string().trim().min(1).optional().nullable(),
  doCliente: z.string().trim().min(1).optional().nullable(),
  eta: optionalDate,
  comentarios: z.string().trim().min(1).optional().nullable(),
});

export const tramiteUpdateSchema = z.object({
  proveedorCliente: z.string().trim().min(1).optional().nullable(),
  agenciaAduanas: z.nativeEnum(AgenciaAduanas).optional(),
  doAgencia: z.string().trim().min(1).optional().nullable(),
  doCliente: z.string().trim().min(1).optional().nullable(),
  eta: optionalDate,
  comentarios: z.string().trim().min(1).optional().nullable(),
  fechaAceptacionDeclaracion: optionalDate,
  fechaLevante: optionalDate,
  fechaEnviadoAFacturar: optionalDate,
  fechaDocumentosOk: optionalDate,
  fechaSalidaCarga: optionalDate,
});

export const estadoTransitionSchema = z.object({
  estado: z.nativeEnum(EstadoTramite),
});

export const checklistUpdateSchema = z.object({
  recibido: z.boolean(),
});

export const tramiteQuerySchema = z.object({
  q: z.string().trim().optional(),
  estado: z.nativeEnum(EstadoTramite).optional(),
  ciudad: z.nativeEnum(Ciudad).optional(),
  clienteId: z.string().trim().min(1).optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});
