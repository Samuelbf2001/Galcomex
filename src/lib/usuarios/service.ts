import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";

export class UsuarioNoEncontradoError extends Error {
  constructor() {
    super("Usuario no encontrado");
    this.name = "UsuarioNoEncontradoError";
  }
}

export async function listarUsuarios() {
  return prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      rol: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });
}

export async function restablecerPassword(
  usuarioId: string,
  nuevaPassword: string,
  adminId: string,
): Promise<void> {
  const usuario = await prisma.user.findUnique({
    where: { id: usuarioId },
    select: { id: true },
  });

  if (!usuario) {
    throw new UsuarioNoEncontradoError();
  }

  const ctx = await auth.$context;
  const hashed = await ctx.password.hash(nuevaPassword);

  await ctx.internalAdapter.updatePassword(usuarioId, hashed);

  // Cierra todas las sesiones activas del usuario tras el reset.
  await prisma.session.deleteMany({ where: { userId: usuarioId } });

  await prisma.auditLog.create({
    data: {
      entidad: "User",
      entidadId: usuarioId,
      accion: "RESET_PASSWORD",
      usuarioId: adminId,
    },
  });
}
