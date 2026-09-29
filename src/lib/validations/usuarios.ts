import { z } from "zod";

import {
  MENSAJE_PASSWORD_CORTA,
  MENSAJE_PASSWORD_LARGA,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "@/lib/auth/estado-cuenta";

export const ROLES_USUARIO = ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const;

/** Mensaje en español para cuerpos que no son objeto o traen campos de más. */
function errorDeObjeto(issue: { code: string; keys?: string[] }): string {
  if (issue.code === "unrecognized_keys" && issue.keys?.length) {
    return `Campos no permitidos: ${issue.keys.join(", ")}`;
  }
  return "El cuerpo debe ser un objeto JSON";
}

const rolSchema = z.enum(ROLES_USUARIO, {
  message: "Rol inválido: usa ADMIN, REVISOR, OPERATIVO o SOCIO",
});

const nombreSchema = z
  .string({ message: "El nombre es obligatorio" })
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres")
  .max(120, "El nombre no puede tener más de 120 caracteres");

const emailSchema = z
  .string({ message: "El correo es obligatorio" })
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Correo inválido" }).max(254, "El correo es demasiado largo"));

/** POST /api/usuarios — la contraseña NO se recibe: el sistema genera una temporal. */
export const crearUsuarioSchema = z.strictObject(
  {
    name: nombreSchema,
    email: emailSchema,
    rol: rolSchema,
  },
  { error: errorDeObjeto },
);

/** PATCH /api/usuarios/[id] — el correo no se cambia (es el usuario de acceso). */
export const actualizarUsuarioSchema = z
  .strictObject(
    {
      name: nombreSchema.optional(),
      rol: rolSchema.optional(),
      activo: z.boolean({ message: "«activo» debe ser true o false" }).optional(),
    },
    { error: errorDeObjeto },
  )
  .refine((v) => v.name !== undefined || v.rol !== undefined || v.activo !== undefined, {
    message: "Indica al menos un cambio: name, rol o activo",
  });

/**
 * POST /api/usuarios/[id]/reset-password. Sin `nuevaPassword` (o cuerpo
 * vacío) el sistema genera una clave temporal y la devuelve una sola vez; con
 * ella (compatibilidad con la tool MCP `usuario_reset_password`) se usa la
 * que manda el ADMIN. En ambos casos el usuario debe cambiarla al entrar.
 */
export const resetPasswordSchema = z.strictObject(
  {
    nuevaPassword: z
      .string({ message: "La contraseña debe ser texto" })
      .min(PASSWORD_MIN, MENSAJE_PASSWORD_CORTA)
      .max(PASSWORD_MAX, MENSAJE_PASSWORD_LARGA)
      .optional(),
  },
  { error: errorDeObjeto },
);

export type CrearUsuarioInput = z.infer<typeof crearUsuarioSchema>;
export type ActualizarUsuarioInput = z.infer<typeof actualizarUsuarioSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
