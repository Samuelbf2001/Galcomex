import { CategoriaDocumento } from "@prisma/client";
import { z } from "zod";

export const solicitarSubidaSchema = z.object({
  action: z.literal("uploadUrl"),
  tramiteId: z.string().min(1),
  categoria: z.nativeEnum(CategoriaDocumento),
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

export type SolicitarSubidaInput = z.infer<typeof solicitarSubidaSchema>;
export type RegistrarDocumentoInput = z.infer<typeof registrarDocumentoSchema>;
