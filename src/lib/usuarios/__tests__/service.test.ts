// @vitest-environment node
/**
 * Servicio de usuarios (integración con BD): alta con clave temporal, reglas
 * de edición (auto-desactivación, último ADMIN, carrera entre dos ADMIN),
 * restablecimiento de clave, sesiones y AuditLog.
 *
 * Requiere DATABASE_URL con Postgres local; se omite si no está.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import {
  MENSAJE_AUTO_DESACTIVAR,
  MENSAJE_AUTO_QUITAR_ADMIN,
  MENSAJE_ULTIMO_ADMIN,
} from "@/lib/usuarios/reglas";
import {
  EmailDuplicadoError,
  PasswordInvalidaError,
  ReglaUsuarioError,
  UsuarioNoEncontradoError,
  actualizarUsuario,
  crearUsuario,
  listarUsuarios,
  restablecerPassword,
} from "@/lib/usuarios/service";

const RUN_ID = `vitest-usuarios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";
const idsCreados: string[] = [];

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

function email(sufijo: string) {
  return `${RUN_ID}-${sufijo}@example.test`;
}

async function crearDirecto(sufijo: string, rol: "ADMIN" | "REVISOR" | "OPERATIVO" | "SOCIO") {
  const u = await prisma.user.create({
    data: { name: `Vitest ${sufijo}`, email: email(sufijo), rol, emailVerified: true },
  });
  idsCreados.push(u.id);
  return u;
}

async function crearSesion(userId: string) {
  return prisma.session.create({
    data: {
      userId,
      token: `${RUN_ID}-${userId}-${Math.random().toString(36).slice(2)}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

async function hashDe(userId: string): Promise<string> {
  const cuenta = await prisma.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  if (!cuenta?.password) throw new Error("Sin cuenta credential");
  return cuenta.password;
}

async function verifica(userId: string, password: string): Promise<boolean> {
  const ctx = await auth.$context;
  return ctx.password.verify({ hash: await hashDe(userId), password });
}

async function motivoRegla(promesa: Promise<unknown>): Promise<string | null> {
  try {
    await promesa;
    return null;
  } catch (error) {
    if (error instanceof ReglaUsuarioError) return error.message;
    throw error;
  }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de usuarios";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  adminId = (await crearDirecto("admin", "ADMIN")).id;
});

afterAll(async () => {
  if (!dbConnected) return;
  const creados = await prisma.user.findMany({
    where: { email: { startsWith: RUN_ID } },
    select: { id: true },
  });
  const ids = [...new Set([...idsCreados, ...creados.map((u) => u.id)])];
  await prisma.auditLog.deleteMany({
    where: { OR: [{ usuarioId: { in: ids } }, { entidad: "User", entidadId: { in: ids } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("crearUsuario", () => {
  it("normaliza el correo, genera clave temporal hasheada y marca debeCambiarPassword", async (ctx) => {
    ensureDb(ctx);
    const correo = `  ${RUN_ID}-Nuevo.Usuario@Example.TEST `;
    const { usuario, passwordTemporal } = await crearUsuario(
      { name: "  Nueva Persona ", email: correo, rol: "OPERATIVO" },
      adminId,
    );

    expect(usuario.email).toBe(correo.trim().toLowerCase());
    expect(usuario.name).toBe("Nueva Persona");
    expect(usuario.activo).toBe(true);
    expect(usuario.debeCambiarPassword).toBe(true);
    expect(passwordTemporal).toHaveLength(14);

    // La clave queda con el hasher de Better Auth, nunca en claro.
    const hash = await hashDe(usuario.id);
    expect(hash).not.toContain(passwordTemporal);
    expect(await verifica(usuario.id, passwordTemporal)).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "User", entidadId: usuario.id, accion: "CREATE" },
    });
    expect(audit?.usuarioId).toBe(adminId);
    const auditTexto = JSON.stringify(audit);
    expect(auditTexto).not.toContain(passwordTemporal);
    expect(auditTexto).not.toContain(hash);
  });

  it("rechaza un correo repetido aunque cambien mayúsculas (409)", async (ctx) => {
    ensureDb(ctx);
    const base = email("duplicado");
    await crearUsuario({ name: "Primero", email: base, rol: "REVISOR" }, adminId);

    const error = await crearUsuario(
      { name: "Segundo", email: base.toUpperCase(), rol: "REVISOR" },
      adminId,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDuplicadoError);
    expect((error as EmailDuplicadoError).status).toBe(409);
    expect(await prisma.user.count({ where: { email: base } })).toBe(1);
  });
});

describe("actualizarUsuario", () => {
  it("un ADMIN no puede desactivarse ni quitarse el rol a sí mismo", async (ctx) => {
    ensureDb(ctx);
    expect(await motivoRegla(actualizarUsuario(adminId, { activo: false }, adminId))).toBe(
      MENSAJE_AUTO_DESACTIVAR,
    );
    expect(await motivoRegla(actualizarUsuario(adminId, { rol: "REVISOR" }, adminId))).toBe(
      MENSAJE_AUTO_QUITAR_ADMIN,
    );
    const yo = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(yo.activo).toBe(true);
    expect(yo.rol).toBe("ADMIN");
  });

  it("desactivar borra sus sesiones y deja AuditLog antes/después; reactivar lo devuelve", async (ctx) => {
    ensureDb(ctx);
    const otro = await crearDirecto("desactivar", "OPERATIVO");
    await crearSesion(otro.id);
    await crearSesion(otro.id);

    const desactivado = await actualizarUsuario(otro.id, { activo: false }, adminId);
    expect(desactivado.activo).toBe(false);
    expect(await prisma.session.count({ where: { userId: otro.id } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "User", entidadId: otro.id, accion: "DESACTIVAR" },
    });
    expect(audit?.usuarioId).toBe(adminId);
    expect(audit?.antes).toMatchObject({ activo: true, rol: "OPERATIVO" });
    expect(audit?.despues).toMatchObject({ activo: false, rol: "OPERATIVO" });

    const reactivado = await actualizarUsuario(otro.id, { activo: true, rol: "REVISOR" }, adminId);
    expect(reactivado).toMatchObject({ activo: true, rol: "REVISOR" });
    expect(
      await prisma.auditLog.count({
        where: { entidad: "User", entidadId: otro.id, accion: "REACTIVAR" },
      }),
    ).toBe(1);
  });

  it("un cambio sin efecto no escribe AuditLog", async (ctx) => {
    ensureDb(ctx);
    const otro = await crearDirecto("sin-cambio", "SOCIO");
    await actualizarUsuario(otro.id, { rol: "SOCIO", activo: true, name: otro.name }, adminId);
    expect(await prisma.auditLog.count({ where: { entidad: "User", entidadId: otro.id } })).toBe(0);
  });

  it("usuario inexistente → 404", async (ctx) => {
    ensureDb(ctx);
    const error = await actualizarUsuario("no-existe", { name: "X y Z" }, adminId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UsuarioNoEncontradoError);
  });

  it("nunca deja el sistema sin ADMIN activo, ni con dos ADMIN quitándose el rol a la vez", async (ctx) => {
    ensureDb(ctx);
    const x = await crearDirecto("admin-x", "ADMIN");
    const y = await crearDirecto("admin-y", "ADMIN");

    // Deja a X e Y como únicos ADMIN activos (BD de pruebas; se restaura al final).
    const otrosAdmins = await prisma.user.findMany({
      where: { rol: "ADMIN", activo: true, id: { notIn: [x.id, y.id] } },
      select: { id: true },
    });
    const otrosIds = otrosAdmins.map((a) => a.id);
    await prisma.user.updateMany({ where: { id: { in: otrosIds } }, data: { activo: false } });

    try {
      // Carrera: X degrada a Y mientras Y degrada a X. Sin el FOR UPDATE ambos
      // pasarían la regla y el sistema quedaría sin ADMIN.
      const resultados = await Promise.allSettled([
        actualizarUsuario(y.id, { rol: "OPERATIVO" }, x.id),
        actualizarUsuario(x.id, { rol: "OPERATIVO" }, y.id),
      ]);
      const ok = resultados.filter((r) => r.status === "fulfilled");
      const rechazados = resultados.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(rechazados).toHaveLength(1);
      const razon = (rechazados[0] as PromiseRejectedResult).reason as Error;
      expect(razon).toBeInstanceOf(ReglaUsuarioError);
      expect(razon.message).toBe(MENSAJE_ULTIMO_ADMIN);

      const adminsActivos = await prisma.user.count({
        where: { rol: "ADMIN", activo: true, id: { in: [x.id, y.id] } },
      });
      expect(adminsActivos).toBe(1);

      // Y el que queda tampoco puede ser desactivado por un tercero.
      const queda = await prisma.user.findFirstOrThrow({
        where: { rol: "ADMIN", activo: true, id: { in: [x.id, y.id] } },
      });
      expect(await motivoRegla(actualizarUsuario(queda.id, { activo: false }, adminId))).toBe(
        MENSAJE_ULTIMO_ADMIN,
      );
    } finally {
      await prisma.user.updateMany({ where: { id: { in: otrosIds } }, data: { activo: true } });
    }
  });
});

describe("restablecerPassword", () => {
  it("sin clave genera una temporal, marca el cambio obligatorio y cierra sesiones", async (ctx) => {
    ensureDb(ctx);
    const otro = await crearDirecto("reset", "REVISOR");
    await crearSesion(otro.id);

    const { passwordTemporal } = await restablecerPassword(otro.id, adminId);
    expect(passwordTemporal).toHaveLength(14);
    expect(await verifica(otro.id, passwordTemporal ?? "")).toBe(true);

    const despues = await prisma.user.findUniqueOrThrow({ where: { id: otro.id } });
    expect(despues.debeCambiarPassword).toBe(true);
    expect(await prisma.session.count({ where: { userId: otro.id } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "User", entidadId: otro.id, accion: "RESET_PASSWORD" },
    });
    expect(audit?.usuarioId).toBe(adminId);
    expect(JSON.stringify(audit)).not.toContain(passwordTemporal ?? "¬");
  });

  it("con clave explícita (tool MCP) la usa, no la devuelve y también obliga a cambiarla", async (ctx) => {
    ensureDb(ctx);
    const otro = await crearDirecto("reset-explicito", "OPERATIVO");
    const { passwordTemporal } = await restablecerPassword(otro.id, adminId, "ClaveDelAdmin-2026");
    expect(passwordTemporal).toBeNull();
    expect(await verifica(otro.id, "ClaveDelAdmin-2026")).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otro.id } })).debeCambiarPassword).toBe(
      true,
    );
  });

  it("rechaza una clave de menos de 10 caracteres y un usuario inexistente", async (ctx) => {
    ensureDb(ctx);
    const otro = await crearDirecto("reset-corta", "OPERATIVO");
    await expect(restablecerPassword(otro.id, adminId, "corta123")).rejects.toBeInstanceOf(
      PasswordInvalidaError,
    );
    await expect(restablecerPassword("no-existe", adminId)).rejects.toBeInstanceOf(
      UsuarioNoEncontradoError,
    );
  });
});

describe("listarUsuarios", () => {
  it("incluye estado, clave temporal, fecha de alta y último ingreso", async (ctx) => {
    ensureDb(ctx);
    const otro = await crearDirecto("listar", "SOCIO");
    const sesion = await crearSesion(otro.id);
    const fila = (await listarUsuarios()).find((u) => u.id === otro.id);
    expect(fila).toMatchObject({
      email: email("listar"),
      rol: "SOCIO",
      activo: true,
      debeCambiarPassword: false,
      ultimoIngreso: sesion.createdAt.toISOString(),
    });
    expect(typeof fila?.createdAt).toBe("string");
  });
});
