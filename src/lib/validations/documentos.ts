import { CategoriaDocumento } from "@prisma/client";
import { z } from "zod";

export const solicitarSubidaSchema = z.object({
  action: z.literal("uploadUrl"),
  tramiteId: z.string().min(1),
  categoria: z.nativeEnum(CategoriaDocumento),
  carpeta: z.string().min(1).optional(),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

export const registrarDocumentoSchema = z.object({
  action: z.literal("register"),
  categoria: z.nativeEnum(CategoriaDocumento),
  nombreArchivo: z.string().min(1),
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
  tamanoBytes: z.number().int().positive(),
});

export const reemplazarDocumentoSchema = z.object({
  storageKey: z.string().min(1),
  nombreArchivo: z.string().min(1),
  mimeType: z.string().min(1),
  tamanoBytes: z.number().int().positive(),
});

/** PATCH: renombrar y/o recategorizar sin volver a subir. Al menos un campo. */
export const actualizarDocumentoSchema = z
  .object({
    nombreArchivo: z.string().trim().min(1).max(255).optional(),
    categoria: z.nativeEnum(CategoriaDocumento).optional(),
  })
  .refine((v) => v.nombreArchivo !== undefined || v.categoria !== undefined, {
    message: "Indica nombreArchivo y/o categoria",
  });

export type ActualizarDocumentoPayload = z.infer<typeof actualizarDocumentoSchema>;

export type SolicitarSubidaInput = z.infer<typeof solicitarSubidaSchema>;
export type RegistrarDocumentoInput = z.infer<typeof registrarDocumentoSchema>;
export type ReemplazarDocumentoInput = z.infer<typeof reemplazarDocumentoSchema>;
