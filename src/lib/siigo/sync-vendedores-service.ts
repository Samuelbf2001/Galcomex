import { prisma } from "@/lib/db/prisma";
import {
  getToken,
  getUsers,
  SiigoApiError,
  SiigoConfigError,
} from "@/lib/siigo/client";

export type SyncVendedoresResult =
  | { ok: true; total: number }
  | { ok: false; error: string; tipo: "config" | "api" | "db" };

export async function sincronizarVendedoresSiigo(
  usuarioId: string,
): Promise<SyncVendedoresResult> {
  try {
    const token = await getToken();
    const usuarios = await getUsers(token);

    const antesCount = await prisma.siigoVendedor.count();

    await prisma.$transaction(
      usuarios.map((u) => {
        const nombre =
          [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
        return prisma.siigoVendedor.upsert({
          where: { id: u.id },
          update: {
            username: u.username ?? null,
            nombre,
            email: u.email ?? null,
            activo: u.active ?? true,
          },
          create: {
            id: u.id,
            username: u.username ?? null,
            nombre,
            email: u.email ?? null,
            activo: u.active ?? true,
          },
        });
      }),
    );

    await prisma.auditLog.create({
      data: {
        entidad: "SiigoVendedor",
        entidadId: "catalog",
        accion: "SYNC",
        usuarioId,
        antes: { totalAntes: antesCount },
        despues: {
          totalDespues: usuarios.length,
          sincronizadoEn: new Date().toISOString(),
        },
      },
    });

    return { ok: true, total: usuarios.length };
  } catch (error) {
    if (error instanceof SiigoConfigError) {
      return { ok: false, error: error.message, tipo: "config" };
    }
    if (error instanceof SiigoApiError) {
      return { ok: false, error: error.message, tipo: "api" };
    }
    throw error;
  }
}
