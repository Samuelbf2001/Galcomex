// @vitest-environment node
/**
 * Acceso según el estado de la cuenta, con Better Auth REAL contra la BD de
 * pruebas (no se mockea `auth`): cookies de verdad, hooks de verdad.
 *
 * - Desactivado: no inicia sesión ni por /api/login ni por el flujo nativo.
 * - Clave temporal: el API responde 403 DEBE_CAMBIAR_PASSWORD, las páginas
 *   redirigen a /cambiar-password y esa página sí abre.
 * - Cambiar la clave (endpoint de Better Auth) apaga la marca y reescribe la
 *   cookie cacheada: no queda atascado 5 min.
 *
 * Requiere DATABASE_URL con Postgres local; se omite si no está.
 */
import "dotenv/config";

import { NextRequest, NextResponse } from "next/server";
import { isValidElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks: solo el contexto de request de Next ────────────────────────────────

const estado = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(estado.cookie ? { cookie: estado.cookie } : {}),
  cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }),
}));

class RedireccionDePrueba extends Error {
  constructor(public readonly destino: string) {
    super(`redirect:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedireccionDePrueba(destino);
  },
}));

// ── Importaciones post-mock ───────────────────────────────────────────────────

import CambiarPasswordPage from "@/app/(dashboard)/cambiar-password/page";
import { POST as loginPOST } from "@/app/api/login/route";
import { ChangePasswordForm } from "@/components/layout/change-password-form";
import { auth } from "@/lib/auth/auth";
import {
  CODIGO_DEBE_CAMBIAR_PASSWORD,
  CODIGO_PASSWORD_REPETIDA,
  CODIGO_USUARIO_DESACTIVADO,
  MENSAJE_USUARIO_DESACTIVADO,
} from "@/lib/auth/estado-cuenta";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";
import { getCurrentSession, requireRole, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { resetRateLimitParaTests } from "@/lib/http/rate-limit";
import { actualizarUsuario, crearUsuario, restablecerPassword } from "@/lib/usuarios/service";

// ── Estado / helpers ──────────────────────────────────────────────────────────

const RUN_ID = `vitest-acceso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CLAVE = "ClaveSegura-2026";

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

function correo(sufijo: string) {
  return `${RUN_ID}-${sufijo}@example.test`;
}

/** Convierte los Set-Cookie de una respuesta en la cabecera Cookie del siguiente request. */
function cookieDe(response: Response, previa = ""): string {
  const jar = new Map<string, string>();
  for (const par of previa.split(";").map((p) => p.trim()).filter(Boolean)) {
    const i = par.indexOf("=");
    jar.set(par.slice(0, i), par.slice(i + 1));
  }
  for (const linea of response.headers.getSetCookie()) {
    const [par, ...atributos] = linea.split(";").map((p) => p.trim());
    const i = par.indexOf("=");
    const nombre = par.slice(0, i);
    const expirada = atributos.some((a) => a.toLowerCase() === "max-age=0");
    if (expirada) jar.delete(nombre);
    else jar.set(nombre, par.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Usuario guardado en la cookie `session_data` (estrategia compact de Better Auth). */
function usuarioEnCookie(cookie: string): Record<string, unknown> | null {
  const par = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("better-auth.session_data="));
  if (!par) return null;
  const valor = decodeURIComponent(par.slice("better-auth.session_data=".length));
  const json = JSON.parse(Buffer.from(valor, "base64url").toString("utf8")) as {
    session: { user: Record<string, unknown> };
  };
  return json.session.user;
}

function sinCookieCache(cookie: string): string {
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => !p.startsWith("better-auth.session_data"))
    .join("; ");
}

async function iniciarSesionNativa(email: string, password: string): Promise<Response> {
  return auth.api.signInEmail({
    body: { email, password },
    headers: new Headers(),
    asResponse: true,
  });
}

function peticionLogin(email: string, password: string): NextRequest {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  form.set("callbackURL", "/dashboard");
  return new NextRequest("http://localhost:3000/api/login", {
    method: "POST",
    body: form,
    headers: { accept: "application/json", "x-real-ip": `10.9.${Math.floor(Math.random() * 250)}.1` },
  });
}

/** Crea un usuario (clave temporal) y le fija una clave conocida. */
async function usuarioConClave(sufijo: string, opciones: { temporal: boolean }) {
  const { usuario } = await crearUsuario(
    { name: `Vitest ${sufijo}`, email: correo(sufijo), rol: "OPERATIVO" },
    adminId,
  );
  await restablecerPassword(usuario.id, adminId, CLAVE);
  if (!opciones.temporal) {
    await prisma.user.update({ where: { id: usuario.id }, data: { debeCambiarPassword: false } });
  }
  return usuario;
}

async function capturarRedireccion(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof RedireccionDePrueba) return error.destino;
    throw error;
  }
}

function buscarElemento(nodo: ReactNode, tipo: unknown): { props: Record<string, unknown> } | null {
  if (Array.isArray(nodo)) {
    for (const hijo of nodo) {
      const encontrado = buscarElemento(hijo, tipo);
      if (encontrado) return encontrado;
    }
    return null;
  }
  if (!isValidElement(nodo)) return null;
  const props = nodo.props as Record<string, unknown> & { children?: ReactNode };
  if (nodo.type === tipo) return { props };
  return buscarElemento(props.children, tipo);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de acceso";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const admin = await prisma.user.create({
    data: { name: "Vitest admin acceso", email: correo("admin"), rol: "ADMIN", emailVerified: true },
  });
  adminId = admin.id;
});

beforeEach(() => {
  estado.cookie = "";
  resetRateLimitParaTests();
});

afterAll(async () => {
  if (!dbConnected) return;
  const ids = (
    await prisma.user.findMany({ where: { email: { startsWith: RUN_ID } }, select: { id: true } })
  ).map((u) => u.id);
  await prisma.auditLog.deleteMany({
    where: { OR: [{ usuarioId: { in: ids } }, { entidad: "User", entidadId: { in: ids } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("usuario desactivado", () => {
  it("no inicia sesión por el flujo nativo de Better Auth (hook session.create.before)", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("inactivo-nativo", { temporal: false });
    await actualizarUsuario(usuario.id, { activo: false }, adminId);

    const res = await iniciarSesionNativa(correo("inactivo-nativo"), CLAVE);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: CODIGO_USUARIO_DESACTIVADO });
    expect(res.headers.getSetCookie().some((c) => c.includes("session_token="))).toBe(false);
    expect(await prisma.session.count({ where: { userId: usuario.id } })).toBe(0);
  });

  it("en /api/login recibe el mensaje claro solo con la clave correcta", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("inactivo-login", { temporal: false });
    await actualizarUsuario(usuario.id, { activo: false }, adminId);

    const correcta = await loginPOST(peticionLogin(correo("inactivo-login"), CLAVE));
    expect(correcta.status).toBe(403);
    expect(await correcta.json()).toEqual({
      error: MENSAJE_USUARIO_DESACTIVADO,
      codigo: CODIGO_USUARIO_DESACTIVADO,
    });

    // Con clave equivocada no se revela que la cuenta existe y está desactivada.
    const incorrecta = await loginPOST(peticionLogin(correo("inactivo-login"), "otra-clave-xx"));
    expect(incorrecta.status).toBe(401);
    expect(await incorrecta.json()).toEqual({ error: "Correo o contraseña inválidos." });
  });

  it("reactivado vuelve a entrar", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("reactivado", { temporal: false });
    await actualizarUsuario(usuario.id, { activo: false }, adminId);
    await actualizarUsuario(usuario.id, { activo: true }, adminId);

    const res = await loginPOST(peticionLogin(correo("reactivado"), CLAVE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirectTo: "/dashboard" });
  });

  it("con la sesión ya leída de BD: el API responde 401 y las páginas lo mandan al login", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("inactivo-sesion", { temporal: false });
    const login = await iniciarSesionNativa(correo("inactivo-sesion"), CLAVE);
    // Se marca inactivo SIN borrar sesiones y sin cookie cacheada: simula que
    // venció la caché de 5 min y getSession lee el usuario de BD.
    await prisma.user.update({ where: { id: usuario.id }, data: { activo: false } });
    estado.cookie = sinCookieCache(cookieDe(login));

    const res = await requireSession();
    expect(res).toBeInstanceOf(NextResponse);
    const respuesta = res as NextResponse;
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ codigo: CODIGO_USUARIO_DESACTIVADO });

    expect(await getCurrentSession()).toBeNull();
    expect(await capturarRedireccion(() => exigirAccesoPagina("/tramites"))).toBe(
      "/auth/login?error=desactivado",
    );
  });
});

describe("clave temporal (debeCambiarPassword)", () => {
  it("/api/login la manda directo a /cambiar-password", async (ctx) => {
    ensureDb(ctx);
    await usuarioConClave("temporal-login", { temporal: true });
    const res = await loginPOST(peticionLogin(correo("temporal-login"), CLAVE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirectTo: "/cambiar-password" });
  });

  it("bloquea el API con 403 DEBE_CAMBIAR_PASSWORD, redirige las páginas y deja abrir /cambiar-password", async (ctx) => {
    ensureDb(ctx);
    await usuarioConClave("temporal-api", { temporal: true });
    estado.cookie = cookieDe(await iniciarSesionNativa(correo("temporal-api"), CLAVE));
    expect(usuarioEnCookie(estado.cookie)).toMatchObject({ debeCambiarPassword: true });

    for (const res of [await requireSession(), await requireRole(["OPERATIVO"])]) {
      expect(res).toBeInstanceOf(NextResponse);
      const respuesta = res as NextResponse;
      expect(respuesta.status).toBe(403);
      expect(await respuesta.json()).toMatchObject({ codigo: CODIGO_DEBE_CAMBIAR_PASSWORD });
    }

    expect(await capturarRedireccion(() => exigirAccesoPagina("/tramites"))).toBe(
      "/cambiar-password",
    );

    // La página de cambio abre (no redirige) y le pide el cambio obligatorio.
    let pagina: ReactNode = null;
    const destino = await capturarRedireccion(async () => {
      pagina = await CambiarPasswordPage();
    });
    expect(destino).toBeNull();
    expect(buscarElemento(pagina, ChangePasswordForm)?.props.obligatorio).toBe(true);
  });

  it("cambiar la clave apaga la marca, deja AuditLog y reescribe la cookie (sin esperar 5 min)", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("temporal-cambio", { temporal: true });
    const cookieInicial = cookieDe(await iniciarSesionNativa(correo("temporal-cambio"), CLAVE));

    // Igual que `authClient.changePassword` en el formulario: POST por HTTP.
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/change-password", {
        method: "POST",
        headers: {
          cookie: cookieInicial,
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: CLAVE,
          newPassword: "MiClaveNueva-2026",
          revokeOtherSessions: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    // El navegador aplica los Set-Cookie en orden: el último session_data manda.
    const datos = res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_data="));
    expect(usuarioEnCookie(datos[datos.length - 1]!.split(";")[0]!)).toMatchObject({
      debeCambiarPassword: false,
    });

    const bd = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(bd.debeCambiarPassword).toBe(false);
    expect(
      await prisma.auditLog.count({
        where: { entidad: "User", entidadId: usuario.id, accion: "CAMBIAR_PASSWORD" },
      }),
    ).toBe(1);

    // La cookie que recibe el navegador ya dice debeCambiarPassword: false.
    estado.cookie = cookieDe(res, cookieInicial);
    expect(usuarioEnCookie(estado.cookie)).toMatchObject({ debeCambiarPassword: false });

    const sesion = await requireRole(["OPERATIVO"]);
    expect(sesion).not.toBeInstanceOf(NextResponse);
    expect(await capturarRedireccion(() => exigirAccesoPagina("/tramites"))).toBeNull();

    // Entra con la nueva, no con la temporal.
    expect((await iniciarSesionNativa(correo("temporal-cambio"), "MiClaveNueva-2026")).status).toBe(200);
    expect((await iniciarSesionNativa(correo("temporal-cambio"), CLAVE)).status).toBe(401);
  });

  it("sin revocar otras sesiones también reescribe la cookie de la sesión actual", async (ctx) => {
    ensureDb(ctx);
    await usuarioConClave("temporal-sin-revocar", { temporal: true });
    const cookieInicial = cookieDe(await iniciarSesionNativa(correo("temporal-sin-revocar"), CLAVE));

    const res = await auth.api.changePassword({
      body: { currentPassword: CLAVE, newPassword: "OtraClaveNueva-26" },
      headers: new Headers({ cookie: cookieInicial }),
      asResponse: true,
    });
    expect(res.status).toBe(200);
    estado.cookie = cookieDe(res, cookieInicial);
    expect(usuarioEnCookie(estado.cookie)).toMatchObject({ debeCambiarPassword: false });
    expect(await requireSession()).not.toBeInstanceOf(NextResponse);
  });

  it("no puede apagarse la marca ni subirse de rol por /update-user (input: false)", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("temporal-update-user", { temporal: true });
    const cookie = cookieDe(await iniciarSesionNativa(correo("temporal-update-user"), CLAVE));

    for (const body of [{ debeCambiarPassword: false }, { rol: "ADMIN" }, { activo: true }]) {
      await auth.api
        .updateUser({ body, headers: new Headers({ cookie }), asResponse: true })
        .catch(() => null);
    }
    const bd = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(bd).toMatchObject({ debeCambiarPassword: true, rol: "OPERATIVO", activo: true });
  });

  it("si la cookie cacheada quedó vieja pero la BD ya dice false, no lo bloquea", async (ctx) => {
    ensureDb(ctx);
    const usuario = await usuarioConClave("temporal-cache-vieja", { temporal: true });
    estado.cookie = cookieDe(await iniciarSesionNativa(correo("temporal-cache-vieja"), CLAVE));
    await prisma.user.update({ where: { id: usuario.id }, data: { debeCambiarPassword: false } });

    expect(usuarioEnCookie(estado.cookie)).toMatchObject({ debeCambiarPassword: true });
    expect(await requireSession()).not.toBeInstanceOf(NextResponse);
  });

  it("rechaza repetir la clave actual (temporal) y una clave de menos de 10", async (ctx) => {
    ensureDb(ctx);
    await usuarioConClave("temporal-reglas", { temporal: true });
    const cookie = cookieDe(await iniciarSesionNativa(correo("temporal-reglas"), CLAVE));

    // Por HTTP, como lo llama `authClient.changePassword` desde el navegador.
    const cambiarPorHttp = (body: Record<string, unknown>) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/change-password", {
          method: "POST",
          headers: {
            cookie,
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );

    const repetida = await cambiarPorHttp({ currentPassword: CLAVE, newPassword: CLAVE });
    expect(repetida.status).toBe(400);
    expect(await repetida.json()).toMatchObject({ code: CODIGO_PASSWORD_REPETIDA });

    const corta = await cambiarPorHttp({ currentPassword: CLAVE, newPassword: "corta1234" });
    expect(corta.status).toBe(400);
    expect(await corta.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });

    const bd = await prisma.user.findFirstOrThrow({ where: { email: correo("temporal-reglas") } });
    expect(bd.debeCambiarPassword).toBe(true);
  });
});

describe("usuarios existentes (sin marca)", () => {
  it("una clave vieja de 8 caracteres sigue entrando: el mínimo de 10 solo aplica al fijar una nueva", async (ctx) => {
    ensureDb(ctx);
    const { usuario } = await crearUsuario(
      { name: "Vitest legado", email: correo("legado"), rol: "REVISOR" },
      adminId,
    );
    const ctxAuth = await auth.$context;
    await prisma.account.updateMany({
      where: { userId: usuario.id, providerId: "credential" },
      data: { password: await ctxAuth.password.hash("clave8ch") },
    });
    await prisma.user.update({ where: { id: usuario.id }, data: { debeCambiarPassword: false } });

    const res = await loginPOST(peticionLogin(correo("legado"), "clave8ch"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirectTo: "/dashboard" });
  });
});
