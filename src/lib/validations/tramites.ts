import {
  AgenciaAduanas,
  Ciudad,
  EstadoTramite,
  TipoCarga,
  TipoCliente,
} from "@prisma/client";
import { z } from "zod";

const optionalDate = z
  .string()
  .datetime()
  .optional()
  .nullable()
  // `undefined` se conserva: en un PATCH parcial (p. ej. la base de cálculo)
  // un campo ausente no se toca; solo `null` o "" lo borran.
  .transform((value) => (value === undefined ? undefined : value ? new Date(value) : null));

export const tramiteCreateSchema = z.object({
  ciudad: z.nativeEnum(Ciudad),
  anio: z.number().int().min(2020).max(2100).optional(),
  clienteId: z.string().min(1, "El cliente es obligatorio"),
  /** Código de `TipoTramite` (M4). Ausente = IMPORTACION, el trámite de siempre. */
  tipoTramiteCodigo: z.string().trim().min(1).optional(),
  /** N° del informe de la clasificadora u otro documento externo. */
  referenciaExterna: z.string().trim().min(1).optional().nullable(),
  proveedorCliente: z.string().trim().min(1).optional().nullable(),
  /** Opcional: los tipos que no la piden usan el default del tipo de trámite. */
  agenciaAduanas: z.nativeEnum(AgenciaAduanas).optional(),
  doAgencia: z.string().trim().min(1).optional().nullable(),
  doCliente: z.string().trim().min(1).optional().nullable(),
  eta: optionalDate,
  comentarios: z.string().trim().min(1).optional().nullable(),
});

const enteroOpcional = z.number().int().min(0).max(100_000).optional().nullable();

/**
 * Base de cálculo del tarifario (M3). Todos opcionales: el motor de tarifas
 * reporta lo que falta en vez de asumir cero.
 */
export const atributosTramiteSchema = z.object({
  valorCif: z.coerce
    .bigint()
    .refine((v) => v >= 0n, { message: "El valor CIF no puede ser negativo" })
    .optional()
    .nullable(),
  tipoCarga: z.nativeEnum(TipoCarga).optional().nullable(),
  numContenedores: enteroOpcional,
  numDeclaraciones: enteroOpcional,
  numDocumentos: enteroOpcional,
  numItems: enteroOpcional,
  /** Orden de compra del cliente (capacidad `orden_compra_en_revision`, caso Polyrec). */
  ordenCompraNumero: z.string().trim().min(1).max(60).optional().nullable(),
  ordenCompraValor: z.coerce
    .bigint()
    .refine((v) => v >= 0n, { message: "El valor de la orden de compra no puede ser negativo" })
    .optional()
    .nullable(),
});

export const tramiteUpdateSchema = atributosTramiteSchema.extend({
  referenciaExterna: z.string().trim().min(1).optional().nullable(),
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

/**
 * `GET /api/tramites/requisitos`: qué le exige el sistema a un DO de esta
 * empresa y tipo (tarifa vigente, BL y factura comercial) antes de crearlo.
 */
export const requisitosQuerySchema = z.object({
  clienteId: z
    .string({ error: "Indica la empresa del DO." })
    .trim()
    .min(1, "Indica la empresa del DO."),
  /** Código de `TipoTramite`. Ausente = IMPORTACION, igual que al crear. */
  tipoTramiteCodigo: z
    .string({ error: "El tipo de trámite debe ser un texto." })
    .trim()
    .min(1, "El tipo de trámite no puede ir vacío.")
    .max(40, "El tipo de trámite es demasiado largo.")
    .optional(),
});

export type RequisitosQuery = z.infer<typeof requisitosQuerySchema>;

export const checklistUpdateSchema = z.object({
  recibido: z.boolean(),
});

export const tramiteQuerySchema = z.object({
  q: z.string().trim().optional(),
  estado: z.nativeEnum(EstadoTramite).optional(),
  ciudad: z.nativeEnum(Ciudad).optional(),
  clienteId: z.string().trim().min(1).optional(),
  tipoCliente: z.nativeEnum(TipoCliente).optional(),
  // "true"/"false" en el query string; undefined = sin filtro.
  facturado: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});
