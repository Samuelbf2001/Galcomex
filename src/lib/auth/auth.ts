import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

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
    // una cuenta OPERATIVO. Los usuarios se crean por script o por el ADMIN.
    disableSignUp: true,
  },
  session: {
    // La sesión se valida desde una cookie firmada durante 5 min; la BD solo
    // se consulta al vencer. Antes cada request (79 rutas API + layout) hacía
    // un lookup de sesión + usuario en Postgres.
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
    },
  },
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = AuthSession["user"];
