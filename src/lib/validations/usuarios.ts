import { z } from "zod";

export const resetPasswordSchema = z.object({
  nuevaPassword: z
    .string()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .max(128, "La contraseña es demasiado larga"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
