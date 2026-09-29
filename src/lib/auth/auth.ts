import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { setCookieCache } from "better-auth/cookies";
import { nextCookies } from "better-auth/next-js";

import {
  CODIGO_PASSWORD_REPETIDA,
  CODIGO_USUARIO_DESACTIVADO,
  MENSAJE_PASSWORD_REPETIDA,
  MENSAJE_USUARIO_DESACTIVADO,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "@/lib/auth/estado-cuenta";
import { prisma } from "@/lib/db/prisma";

export const roles = ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as [
  "ADMIN",
  "REVISOR",
  "OPERATIVO",
  "SOCIO",
];

export type Rol = (typeof roles)[number];

export const auth = betterAuth({
  appName: "Galcomex",
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    // Sin registro público: `/api/auth/sign-up/email` dejaba a cualquiera crear
    // una cuenta OPERATIVO. Los usuarios los crea el ADMIN en Configuración.
    disableSignUp: true,
    // Solo se exige al fijar una clave nueva (cambio o restablecimiento); el
    // inicio de sesión no mira la longitud, así que las claves viejas de 8-9
    // caracteres siguen entrando.
    minPasswordLength: PASSWORD_MIN,
    maxPasswordLength: PASSWORD_MAX,
  },
  session: {
    // La sesión se valida desde una cookie firmada durante 5 min; la BD solo
    // se consulta al vencer. Antes cada request (79 rutas API + layout) hacía
    // un lookup de sesión + usuario en Postgres.
    //
    // Consecuencia conocida: al desactivar un usuario o restablecer su clave se
    // borran sus sesiones en BD, pero la cookie ya emitida sigue valiendo hasta
    // 5 min (luego getSession va a BD, no encuentra la sesión y lo saca).
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  user: {
    additionalFields: {
      rol: {
        type: roles,
        required: true,
        input: false,
        defaultValue: "OPERATIVO",
      },
      // `input: false`: ni sign-up ni /update-user pueden fijarlos; solo el
      // servicio de usuarios (ADMIN) y el hook de cambio de clave. Sin
      // `defaultValue` a propósito: el valor por defecto lo pone la BD, y así
      // el tipo queda opcional, que es la verdad para las cookies de sesión
      // emitidas antes de la migración (no traen estos campos). Leerlos siempre
      // con `estaDesactivado` / `tieneClaveTemporal` (estado-cuenta.ts).
      activo: {
        type: "boolean",
        required: false,
        input: false,
      },
      debeCambiarPassword: {
        type: "boolean",
        required: false,
        input: false,
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Toda sesión nueva pasa por aquí: /api/login y también el flujo
        // nativo `/api/auth/sign-in/email` (lo usan el MCP y los scripts). Se
        // ejecuta DESPUÉS de verificar la contraseña, así que el mensaje no
        // revela a un tercero si la cuenta existe.
        before: async (session) => {
          const usuario = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { activo: true },
          });
          if (!usuario || !usuario.activo) {
            throw new APIError("FORBIDDEN", {
              message: MENSAJE_USUARIO_DESACTIVADO,
              code: CODIGO_USUARIO_DESACTIVADO,
            });
          }
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password") return;
      const body: unknown = ctx.body;
      if (
        typeof body === "object" &&
        body !== null &&
        "newPassword" in body &&
        "currentPassword" in body &&
        typeof body.newPassword === "string" &&
        body.newPassword === body.currentPassword
      ) {
        throw new APIError("BAD_REQUEST", {
          message: MENSAJE_PASSWORD_REPETIDA,
          code: CODIGO_PASSWORD_REPETIDA,
        });
      }
    }),
    /**
     * Tras un cambio de contraseña propio (`POST /api/auth/change-password`,
     * el que usa `authClient.changePassword`): apaga `debeCambiarPassword`,
     * deja AuditLog y reescribe la cookie `session_data`.
     *
     * Por qué la cookie: Better Auth guarda el usuario en esa cookie firmada
     * (cookieCache, 5 min) y el endpoint la reemite con el usuario VIEJO (aún
     * con `debeCambiarPassword: true`). Sin reescribirla, quien acaba de
     * cambiar su clave temporal seguiría rebotando a /cambiar-password hasta
     * 5 min.
     */
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password") return;
      const devuelto: unknown = ctx.context.returned;
      if (!devuelto || isAPIError(devuelto) || devuelto instanceof Response) return;

      // `sensitiveSessionMiddleware` deja en el contexto la sesión leída de
      // BD; con `revokeOtherSessions` el endpoint crea una nueva (`newSession`).
      const base = ctx.context.newSession ?? ctx.context.session;
      if (!base) return;
      const userId = base.user.id;

      await prisma.$transaction(async (tx) => {
        const antes = await tx.user.findUnique({
          where: { id: userId },
          select: { debeCambiarPassword: true },
        });
        if (!antes) return;
        if (antes.debeCambiarPassword) {
          await tx.user.update({ where: { id: userId }, data: { debeCambiarPassword: false } });
        }
        await tx.auditLog.create({
          data: {
            entidad: "User",
            entidadId: userId,
            accion: "CAMBIAR_PASSWORD",
            usuarioId: userId,
            antes: { debeCambiarPassword: antes.debeCambiarPassword },
            despues: { debeCambiarPassword: false },
          },
        });
      });

      const usuarioActualizado = { ...base.user, debeCambiarPassword: false };
      await setCookieCache(ctx, { session: base.session, user: usuarioActualizado }, false);
    }),
  },
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = AuthSession["user"];
