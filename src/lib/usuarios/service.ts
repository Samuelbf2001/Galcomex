/**
 * Gestión de usuarios por el ADMIN (Configuración → Usuarios).
 *
 * - Nadie se registra solo (`disableSignUp`): el ADMIN crea la cuenta y el
 *   sistema genera una clave temporal que se muestra UNA vez.
 * - Las cuentas no se borran (tienen DOs, pagos y AuditLog a su nombre): se
 *   desactivan con `activo = false`.
 * - Toda mutación va en transacción con AuditLog antes/después. Las claves
 *   (temporales o no) nunca se guardan en claro ni van al AuditLog.
 *
 * Reglas de edición (último ADMIN, auto-desactivación) en `reglas.ts`.
 */

import { Prisma } from "@prisma/client";

import { auth, type Rol } from "@/lib/auth/auth";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/auth/estado-cuenta";
import { prisma } from "@/lib/db/prisma";
import { generarClaveTemporal } from "@/lib/usuarios/clave-temporal";
import { validarCambioUsuario, type CambiosUsuario } from "@/lib/usuarios/reglas";

export { ReglaUsuarioError } from "@/lib/usuarios/reglas";

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class UsuarioNoEncontradoError extends Error {
  public readonly status = 404;
  constructor() {
    super("Usuario no encontrado");
    this.name = "UsuarioNoEncontradoError";
  }
}

export class EmailDuplicadoError extends Error {
  public readonly status = 409;
  constructor(email: string) {
    super(`Ya existe un usuario con el correo ${email}`);
    this.name = "EmailDuplicadoError";
  }
}

export class PasswordInvalidaError extends Error {
  public readonly status = 400;
  constructor() {
    super(`La contraseña debe tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`);
    this.name = "PasswordInvalidaError";
  }
}

// ─── DTO ──────────────────────────────────────────────────────────────────────

export interface UsuarioDto {
  id: string;
  name: string;
  email: string;
  rol: Rol;
  activo: boolean;
  debeCambiarPassword: boolean;
  createdAt: string;
  /** Inicio de la sesión más reciente que sigue guardada (null si cerró todas). */
  ultimoIngreso: string | null;
}

const SELECT_USUARIO = {
  id: true,
  name: true,
  email: true,
  rol: true,
  activo: true,
  debeCambiarPassword: true,
  createdAt: true,
  sessions: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
} satisfies Prisma.UserSelect;

type UsuarioSeleccionado = Prisma.UserGetPayload<{ select: typeof SELECT_USUARIO }>;

function aDto(u: UsuarioSeleccionado): UsuarioDto {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    rol: u.rol,
    activo: u.activo,
    debeCambiarPassword: u.debeCambiarPassword,
    createdAt: u.createdAt.toISOString(),
    ultimoIngreso: u.sessions[0]?.createdAt.toISOString() ?? null,
  };
}

/** Snapshot para el AuditLog: datos de la cuenta, nunca la clave. */
function snapshot(u: {
  name: string;
  email: string;
  rol: Rol;
  activo: boolean;
  debeCambiarPassword: boolean;
}): Prisma.InputJsonValue {
  return {
    name: u.name,
    email: u.email,
    rol: u.rol,
    activo: u.activo,
    debeCambiarPassword: u.debeCambiarPassword,
  };
}

/** Mismo hasher que usa Better Auth al iniciar sesión (scrypt). */
async function hashearPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new PasswordInvalidaError();
  }
  const ctx = await auth.$context;
  return ctx.password.hash(password);
}

function esEmailDuplicado(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ─── Lectura ──────────────────────────────────────────────────────────────────

export async function listarUsuarios(): Promise<UsuarioDto[]> {
  const usuarios = await prisma.user.findMany({
    select: SELECT_USUARIO,
    orderBy: [{ activo: "desc" }, { name: "asc" }],
  });
  return usuarios.map(aDto);
}

// ─── Creación ─────────────────────────────────────────────────────────────────

export async function crearUsuario(
  input: { name: string; email: string; rol: Rol },
  adminId: string,
): Promise<{ usuario: UsuarioDto; passwordTemporal: string }> {
  const name = input.name.trim();
  // Better Auth busca el correo en minúsculas al iniciar sesión.
  const email = input.email.trim().toLowerCase();
  const passwordTemporal = generarClaveTemporal();
  const hash = await hashearPassword(passwordTemporal);

  try {
    const usuario = await prisma.$transaction(async (tx) => {
      const existente = await tx.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (existente) throw new EmailDuplicadoError(email);

      const creado = await tx.user.create({
        data: { name, email, rol: input.rol, activo: true, debeCambiarPassword: true },
        select: SELECT_USUARIO,
      });
      // Misma forma que la cuenta que crea Better Auth al registrarse.
      await tx.account.create({
        data: {
          userId: creado.id,
          accountId: creado.id,
          providerId: "credential",
          password: hash,
        },
      });
      await tx.auditLog.create({
        data: {
          entidad: "User",
          entidadId: creado.id,
          accion: "CREATE",
          usuarioId: adminId,
          despues: snapshot(creado),
        },
      });
      return creado;
    });

    return { usuario: aDto(usuario), passwordTemporal };
  } catch (error) {
    if (esEmailDuplicado(error)) throw new EmailDuplicadoError(email);
    throw error;
  }
}

// ─── Edición ──────────────────────────────────────────────────────────────────

/**
 * Cambia nombre, rol y/o estado. Al desactivar borra sus sesiones en BD; la
 * cookie cacheada que ya tenga puede seguir valiendo hasta 5 min (cookieCache
 * de Better Auth) y después queda fuera. Un cambio de rol se ve en su próxima
 * navegación tras ese mismo plazo, sin cerrarle la sesión.
 */
export async function actualizarUsuario(
  id: string,
  cambios: CambiosUsuario,
  adminId: string,
): Promise<UsuarioDto> {
  const usuario = await prisma.$transaction(async (tx) => {
    // Bloquea a los ADMIN activos: dos cambios simultáneos (p. ej. dos ADMIN
    // quitándose el rol el uno al otro) se ejecutan en fila y el segundo ve el
    // resultado del primero, así que no pueden dejar el sistema sin ADMIN.
    const adminsActivos = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "user" WHERE rol = 'ADMIN' AND activo = true FOR UPDATE`;

    const objetivo = await tx.user.findUnique({ where: { id }, select: SELECT_USUARIO });
    if (!objetivo) throw new UsuarioNoEncontradoError();

    validarCambioUsuario({
      objetivo,
      cambios,
      actorId: adminId,
      adminsActivosIds: adminsActivos.map((a) => a.id),
    });

    const data: Prisma.UserUpdateInput = {};
    if (cambios.name !== undefined && cambios.name.trim() !== objetivo.name) {
      data.name = cambios.name.trim();
    }
    if (cambios.rol !== undefined && cambios.rol !== objetivo.rol) data.rol = cambios.rol;
    if (cambios.activo !== undefined && cambios.activo !== objetivo.activo) {
      data.activo = cambios.activo;
    }
    if (Object.keys(data).length === 0) return objetivo;

    const actualizado = await tx.user.update({ where: { id }, data, select: SELECT_USUARIO });

    if (data.activo === false) {
      await tx.session.deleteMany({ where: { userId: id } });
    }

    await tx.auditLog.create({
      data: {
        entidad: "User",
        entidadId: id,
        accion: data.activo === false ? "DESACTIVAR" : data.activo === true ? "REACTIVAR" : "UPDATE",
        usuarioId: adminId,
        antes: snapshot(objetivo),
        despues: snapshot(actualizado),
      },
    });

    // Tras borrar las sesiones, `sessions` del select ya viene vacío.
    return actualizado;
  });

  return aDto(usuario);
}

// ─── Restablecer contraseña ───────────────────────────────────────────────────

/**
 * Restablece la clave de un usuario. Sin `nuevaPassword` genera una temporal
 * y la devuelve UNA vez (no queda guardada en claro en ninguna parte). En
 * ambos casos el usuario debe cambiarla al entrar y se borran sus sesiones.
 */
export async function restablecerPassword(
  usuarioId: string,
  adminId: string,
  nuevaPassword?: string,
): Promise<{ passwordTemporal: string | null }> {
  const generada = nuevaPassword === undefined;
  const clave = nuevaPassword ?? generarClaveTemporal();
  const hash = await hashearPassword(clave);

  await prisma.$transaction(async (tx) => {
    const usuario = await tx.user.findUnique({
      where: { id: usuarioId },
      select: { id: true, debeCambiarPassword: true },
    });
    if (!usuario) throw new UsuarioNoEncontradoError();

    const { count } = await tx.account.updateMany({
      where: { userId: usuarioId, providerId: "credential" },
      data: { password: hash },
    });
    if (count === 0) {
      await tx.account.create({
        data: {
          userId: usuarioId,
          accountId: usuarioId,
          providerId: "credential",
          password: hash,
        },
      });
    }

    await tx.user.update({ where: { id: usuarioId }, data: { debeCambiarPassword: true } });

    // Cierra todas sus sesiones (la cookie cacheada puede durar hasta 5 min).
    await tx.session.deleteMany({ where: { userId: usuarioId } });

    await tx.auditLog.create({
      data: {
        entidad: "User",
        entidadId: usuarioId,
        accion: "RESET_PASSWORD",
        usuarioId: adminId,
        antes: { debeCambiarPassword: usuario.debeCambiarPassword },
        despues: { debeCambiarPassword: true, claveGeneradaPorElSistema: generada },
      },
    });
  });

  return { passwordTemporal: generada ? clave : null };
}
