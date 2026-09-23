import { z } from "zod";

import { esCodigoCapacidad, type CodigoCapacidad } from "@/lib/capacidades/catalogo";

const codigoCapacidadSchema = z.custom<CodigoCapacidad>(
  (valor) => typeof valor === "string" && esCodigoCapacidad(valor),
  { message: "Capacidad desconocida" },
);

/**
 * Config `{ tiposTramite: [...] }`: a qué tipos de trámite aplica la regla
 * (códigos de `TipoTramite`: IMPORTACION, CLASIFICACION, OTRO…). Una lista
 * vacía es válida: la función queda encendida pero no aplica a ningún tipo.
 */
const configTiposTramiteSchema = z.object({
  tiposTramite: z
    .array(
      z
        .string({ error: "Cada tipo de trámite debe ser un código de texto." })
        .regex(/^[A-Z][A-Z0-9_]*$/, "Código de tipo de trámite inválido (usa el código, p. ej. IMPORTACION)."),
      { error: "Indica a qué tipos de trámite aplica (lista de códigos)." },
    )
    .max(20, "Demasiados tipos de trámite.")
    .refine((tipos) => new Set(tipos).size === tipos.length, {
      message: "Hay tipos de trámite repetidos.",
    }),
});

/**
 * Forma de la config de las capacidades que la tienen estructurada. El resto
 * se valida al leerla, en su consumidor (ver catalogo.ts).
 */
const CONFIG_POR_CAPACIDAD: Partial<Record<CodigoCapacidad, z.ZodType>> = {
  do_exige_tarifa_vigente: configTiposTramiteSchema,
  docs_bl_factura_obligatorios: configTiposTramiteSchema,
};

export const cambioCapacidadSchema = z
  .object({
    codigo: codigoCapacidadSchema,
    /** Borra el override propio y devuelve la capacidad a lo que herede. */
    heredar: z.boolean().optional(),
    habilitado: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine(
    (cambio) =>
      cambio.heredar === true ||
      cambio.habilitado !== undefined ||
      cambio.config !== undefined,
    { message: "El cambio debe indicar habilitado, config o heredar" },
  )
  .superRefine((cambio, ctx) => {
    const schema = CONFIG_POR_CAPACIDAD[cambio.codigo];
    // `null` = volver a la config por defecto: siempre válido.
    if (!schema || cambio.config === null || cambio.config === undefined) return;

    const resultado = schema.safeParse(cambio.config);
    if (resultado.success) return;

    for (const issue of resultado.error.issues) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: ["config", ...issue.path],
      });
    }
  });

export const capacidadesPayloadSchema = z.object({
  cambios: z.array(cambioCapacidadSchema).min(1).max(50),
});

export type CapacidadesPayload = z.infer<typeof capacidadesPayloadSchema>;
