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
