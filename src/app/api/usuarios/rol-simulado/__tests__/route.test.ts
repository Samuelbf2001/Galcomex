/**
 * POST/DELETE /api/usuarios/rol-simulado — solo la administradora (rol REAL),
 * cookie httpOnly y AuditLog. Sin BD: `auth.api.getSession` y Prisma se
 * controlan a mano.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { COOKIE_ROL_SIMULADO, DURACION_SIMULACION_SEG } from "@/lib/auth/rol-simulado";
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

function reqPost(body: unknown, raw?: string) {
  return new NextRequest("http://localhost/api/usuarios/rol-simulado", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
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

describe("POST", () => {
  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "ADMIN elige %s: cookie httpOnly de 4 h y AuditLog PROBAR_ROL_INICIO",
    async (rol) => {
      const res = await POST(reqPost({ rol }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, rol });
      const cookie = res.cookies.get(COOKIE_ROL_SIMULADO);
      expect(cookie).toMatchObject({
        value: rol,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: DURACION_SIMULACION_SEG,
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          entidad: "User",
          entidadId: ADMIN_ID,
          accion: "PROBAR_ROL_INICIO",
          usuarioId: ADMIN_ID,
          despues: { rol },
        },
      });
    },
  );

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
    estado.cookie = `${COOKIE_ROL_SIMULADO}=SOCIO`;
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
    const res = await POST(reqPost(null, "{no es json"));
    expect(res.status).toBe(400);
  });
});

describe("DELETE", () => {
  it("ADMIN que estaba probando un rol: borra la cookie y deja PROBAR_ROL_FIN", async () => {
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=OPERATIVO`));

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

  it("ADMIN sin cookie: ok, sin AuditLog", async () => {
    const res = await DELETE(reqDelete());
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("un no-admin con la cookie: ok y la borra, sin AuditLog", async () => {
    usarSesion(sesion("REVISOR"));
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=SOCIO`));
    expect(res.status).toBe(200);
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("sin sesión: igual borra la cookie y responde ok", async () => {
    usarSesion(null);
    const res = await DELETE(reqDelete(`${COOKIE_ROL_SIMULADO}=SOCIO`));
    expect(res.status).toBe(200);
    expect(res.cookies.get(COOKIE_ROL_SIMULADO)).toMatchObject({ value: "", maxAge: 0 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
