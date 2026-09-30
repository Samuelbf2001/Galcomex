/**
 * POST/DELETE /api/usuarios/rol-simulado — solo la administradora (rol REAL),
 * cookie httpOnly atada a la persona (`ROL.userId`), a prueba de subdominios
 * (`__Host-` en producción) y AuditLog completo. Sin BD: `auth.api.getSession`
 * y Prisma se controlan a mano.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

const estado = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(estado.cookie ? { cookie: estado.cookie } : {}),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
  roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
}));

import { DELETE, POST } from "@/app/api/usuarios/rol-simulado/route";
import { auth } from "@/lib/auth/auth";
import {
  COOKIE_ROL_SIMULADO,
  COOKIE_ROL_SIMULADO_PRODUCCION,
  DURACION_SIMULACION_SEG,
} from "@/lib/auth/rol-simulado";
import { prisma } from "@/lib/db/prisma";

const ADMIN_ID = "admin-1";

function sesion(rol: Rol, extra: { activo?: boolean; debeCambiarPassword?: boolean } = {}) {
  return {
    user: {
      id: ADMIN_ID,
      rol,
      email: "admin@example.test",
      name: "Admin",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ...extra,
    },
    session: {
      id: "s-1",
      userId: ADMIN_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "t",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  };
}

function usarSesion(valor: ReturnType<typeof sesion> | null) {
  vi.mocked(auth.api.getSession).mockResolvedValue(valor as never);
}

function reqPost(
  body: unknown,
  opciones: { raw?: string; contentType?: string | null; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opciones.contentType !== null) {
    headers["content-type"] = opciones.contentType ?? "application/json";
  }
  if (opciones.cookie) headers.cookie = opciones.cookie;
  return new NextRequest("http://localhost/api/usuarios/rol-simulado", {
    method: "POST",
    headers,
    body: opciones.raw ?? JSON.stringify(body),
  });
}

function reqDelete(cookie?: string) {
  return new NextRequest("http://localhost/api/usuarios/rol-simulado", {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.cookie = "";
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  usarSesion(sesion("ADMIN"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST", () => {
  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "ADMIN elige %s: cookie httpOnly ROL.userId de 4 h y AuditLog PROBAR_ROL_INICIO con vencimiento",
    async (rol) => {
      const antes = Date.now();
      const res = await POST(reqPost({ rol }));
      const despues = Date.now();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, rol });
      const cookie = res.cookies.get(COOKIE_ROL_SIMULADO);
      expect(cookie).toMatchObject({
        value: `${rol}.${ADMIN_ID}`,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: DURACION_SIMULACION_SEG,
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const { data } = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as unknown as {
        data: Record<string, unknown> & { despues: { rol: string; hasta: string } };
      };
      expect(data).toEqual({
        entidad: "User",
        entidadId: ADMIN_ID,
        accion: "PROBAR_ROL_INICIO",
        usuarioId: ADMIN_ID,
        despues: { rol, hasta: expect.any(String) },
      });
      // Sin simulación previa no hay «antes».
      expect(data).not.toHaveProperty("antes");
      // `hasta` es el vencimiento real de la cookie (ISO, ahora + 4 h).
      const hasta = new Date(data.despues.hasta);
      expect(hasta.toISOString()).toBe(data.despues.hasta);
      expect(hasta.getTime()).toBeGreaterThanOrEqual(antes + DURACION_SIMULACION_SEG * 1000);
      expect(hasta.getTime()).toBeLessThanOrEqual(despues + DURACION_SIMULACION_SEG * 1000);
    },
  );

  it("fuera de producción la cookie lleva el nombre simple y sin Secure", async () => {
    const res = await POST(reqPost({ rol: "REVISOR" }));
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ secure: false });
    expect(res.cookies.get(COOKIE_ROL_SIMULADO_PRODUCCION)).toBeUndefined();
  });

  it("en producción la cookie se llama __Host-… (Secure, path=/, sin Domain) y vale ROL.userId", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(reqPost({ rol: "OPERATIVO" }));

    expect(res.status).toBe(200);
    const cookie = res.cookies.get("__Host-galcomex_rol_simulado");
    expect(cookie).toMatchObject({
      name: "__Host-galcomex_rol_simulado",
      value: `OPERATIVO.${ADMIN_ID}`,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: DURACION_SIMULACION_SEG,
    });
    expect(cookie).not.toHaveProperty("domain");
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toBeUndefined();
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-galcomex_rol_simulado=/);
  });

  it("si ya había una simulación válida, el AuditLog guarda «antes» con el rol previo", async () => {
    const res = await POST(reqPost({ rol: "OPERATIVO" }, { cookie: `${COOKIE_ROL_SIMULADO}=SOCIO.${ADMIN_ID}` }));

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        entidad: "User",
        entidadId: ADMIN_ID,
        accion: "PROBAR_ROL_INICIO",
        usuarioId: ADMIN_ID,
        antes: { rol: "SOCIO" },
        despues: { rol: "OPERATIVO", hasta: expect.any(String) },
      },
    });
  });

  it.each([
    ["de otra persona", `${COOKIE_ROL_SIMULADO}=SOCIO.otro-admin`],
    ["en el formato viejo", `${COOKIE_ROL_SIMULADO}=SOCIO`],
  ])("una cookie previa %s no cuenta como «antes»", async (_caso, cookie) => {
    const res = await POST(reqPost({ rol: "OPERATIVO" }, { cookie }));

    expect(res.status).toBe(200);
    const { data } = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as unknown as { data: object };
    expect(data).not.toHaveProperty("antes");
  });

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "un %s recibe 403 y no se pone cookie ni AuditLog",
    async (rolReal) => {
      usarSesion(sesion(rolReal));
      const res = await POST(reqPost({ rol: "REVISOR" }));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Solo la administradora puede probar otros roles" });
      expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toBeUndefined();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("una administradora que ya prueba otro rol sigue autorizada (se usa el rol REAL)", async () => {
    estado.cookie = `${COOKIE_ROL_SIMULADO}=SOCIO.${ADMIN_ID}`;
    const res = await POST(reqPost({ rol: "OPERATIVO" }));
    expect(res.status).toBe(200);
  });

  it("sin sesión → 401", async () => {
    usarSesion(null);
    expect((await POST(reqPost({ rol: "REVISOR" }))).status).toBe(401);
  });

  it("ADMIN desactivado → 401 USUARIO_DESACTIVADO", async () => {
    usarSesion(sesion("ADMIN", { activo: false }));
    const res = await POST(reqPost({ rol: "REVISOR" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ codigo: "USUARIO_DESACTIVADO" });
  });

  it("ADMIN con clave temporal → 403 DEBE_CAMBIAR_PASSWORD", async () => {
    usarSesion(sesion("ADMIN", { debeCambiarPassword: true }));
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ debeCambiarPassword: true } as never);
    const res = await POST(reqPost({ rol: "REVISOR" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ codigo: "DEBE_CAMBIAR_PASSWORD" });
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", null])(
    "content-type %j → 415, sin cookie ni AuditLog",
    async (contentType) => {
      const res = await POST(reqPost({ rol: "REVISOR" }, { contentType }));

      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: "La solicitud debe enviarse como JSON." });
      expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toBeUndefined();
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("application/json con charset sí se acepta", async () => {
    const res = await POST(
      reqPost({ rol: "REVISOR" }, { contentType: "application/json; charset=utf-8" }),
    );
    expect(res.status).toBe(200);
  });

  it.each([{ rol: "ADMIN" }, { rol: "x" }, {}, { rol: "REVISOR", extra: 1 }])(
    "cuerpo %j → 400 y sin cookie (nunca se puede subir a ADMIN)",
    async (cuerpo) => {
      const res = await POST(reqPost(cuerpo));
      expect(res.status).toBe(400);
      expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toBeUndefined();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("JSON inválido → 400", async () => {
    const res = await POST(reqPost(null, { raw: "{no es json" }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE", () => {
  it("ADMIN que estaba probando un rol: borra la cookie y deja PROBAR_ROL_FIN", async () => {
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=OPERATIVO.${ADMIN_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0, path: "/" });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        entidad: "User",
        entidadId: ADMIN_ID,
        accion: "PROBAR_ROL_FIN",
        usuarioId: ADMIN_ID,
        antes: { rol: "OPERATIVO" },
      },
    });
  });

  it("con la cookie repetida audita la PRIMERA (la misma que aplica la sesión)", async () => {
    await DELETE(
      reqDelete(
        `${COOKIE_ROL_SIMULADO}=SOCIO.${ADMIN_ID}; ${COOKIE_ROL_SIMULADO}=REVISOR.${ADMIN_ID}`,
      ),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ antes: { rol: "SOCIO" } }),
    });
  });

  it("en producción borra la cookie __Host- y audita al leerla con ese nombre", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO_PRODUCCION}=REVISOR.${ADMIN_ID}`));

    expect(res.status).toBe(200);
    expect(res.cookies.get(COOKIE_ROL_SIMULADO_PRODUCCION)).toMatchObject({
      value: "",
      maxAge: 0,
      path: "/",
      secure: true,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accion: "PROBAR_ROL_FIN", antes: { rol: "REVISOR" } }),
    });
  });

  it("ADMIN sin cookie: ok, sin AuditLog", async () => {
    const res = await DELETE(reqDelete());
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ["de otra persona", `${COOKIE_ROL_SIMULADO}=SOCIO.otro-admin`],
    ["en el formato viejo", `${COOKIE_ROL_SIMULADO}=SOCIO`],
  ])("con una cookie %s: ok y la borra, sin AuditLog", async (_caso, cookie) => {
    const res = await DELETE(reqDelete(cookie));
    expect(res.status).toBe(200);
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("un no-admin con la cookie: ok y la borra, sin AuditLog", async () => {
    usarSesion(sesion("REVISOR"));
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=SOCIO.${ADMIN_ID}`));
    expect(res.status).toBe(200);
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("sin sesión: igual borra la cookie y responde ok", async () => {
    usarSesion(null);
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=SOCIO.${ADMIN_ID}`));
    expect(res.status).toBe(200);
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("«Volver» nunca falla: si el AuditLog lanza error, igual responde ok, borra la cookie y lo registra", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error("BD caída"));

    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=OPERATIVO.${ADMIN_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0, path: "/" });
    expect(consola).toHaveBeenCalledTimes(1);
  });

  it("«Volver» nunca falla: si leer la sesión lanza error, igual responde ok y borra la cookie", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(auth.api.getSession).mockRejectedValue(new Error("sesión ilegible"));

    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=OPERATIVO.${ADMIN_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(consola).toHaveBeenCalledTimes(1);
  });
});
