/**
 * Crea (o actualiza) el usuario del socio Lucho/Luis Martínez con rol SOCIO.
 * Login: lucho@galcomex.com / la contraseña de SOCIO_PASSWORD
 * Uso: SOCIO_PASSWORD=... npx tsx scripts/crear-usuario-socio.ts
 */
import "dotenv/config";
import { Rol } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";

import { prisma } from "../src/lib/db/prisma";

async function main() {
  const password = process.env.SOCIO_PASSWORD;
  if (!password) throw new Error("Define SOCIO_PASSWORD con la contraseña del socio");
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email: "lucho@galcomex.com" },
    update: {
      name: "Lucho (Luis Martínez)",
      emailVerified: true,
      rol: Rol.SOCIO,
      accounts: {
        deleteMany: { providerId: "credential" },
        create: {
          accountId: "lucho@galcomex.com",
          providerId: "credential",
          password: passwordHash,
        },
      },
    },
    create: {
      email: "lucho@galcomex.com",
      name: "Lucho (Luis Martínez)",
      emailVerified: true,
      rol: Rol.SOCIO,
      accounts: {
        create: {
          accountId: "lucho@galcomex.com",
          providerId: "credential",
          password: passwordHash,
        },
      },
    },
  });

  console.log(`✅ Usuario SOCIO listo: ${user.email} (${user.rol})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
