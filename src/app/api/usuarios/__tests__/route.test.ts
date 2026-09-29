/**
 * API de usuarios — permisos, validación Zod y traducción de errores.
 *
 * Estrategia (igual que permisos.test.ts): `auth.api.getSession` devuelve una
 * sesión controlada, `requireRole` REAL decide, y el servicio se mockea (sus
 * reglas se prueban contra la BD en src/lib/usuarios/__tests__/service.test.ts).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

vi.mock("@/lib/usuarios/service", () => {
  class UsuarioNoEncontradoError extends Error {
    public readonly status = 404;
  }
  class EmailDuplicadoError extends Error {
    public readonly status = 409;
  }
  class ReglaUsuarioError extends Error {
    public readonly status = 422;
  }
  return {
    listarUsuarios: vi.fn().mockResolvedValue([]),
    crearUsuario: vi.fn(),
    actualizarUsuario: vi.fn(),
    restablecerPassword: vi.fn(),
    UsuarioNoEncontradoError,
    EmailDuplicadoError,
    ReglaUsuarioError,
  };
});

import { GET, POST } from "@/app/api/usuarios/route";
import { PATCH } from "@/app/api/usuarios/[id]/route";
import { POST as resetPOST } from "@/app/api/usuarios/[id]/reset-password/route";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import * as servicio from "@/lib/usuarios/service";

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

function req(url: string, init?: { method?: string; body?: unknown; raw?: string }) {
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const llamadas = {
  GET: () => GET(),
  POST: () =>
    POST(req("/api/usuarios", { method: "POST", body: { name: "Ana", email: "a@b.co", rol: "REVISOR" } })),
  PATCH: () => PATCH(req("/api/usuarios/u1", { method: "PATCH", body: { activo: false } }), ctx("u1")),
  RESET: () => resetPOST(req("/api/usuarios/u1/reset-password", { method: "POST", body: {} }), ctx("u1")),
};

beforeEach(() => {
  vi.clearAllMocks();
  usarSesion(sesion("ADMIN"));
});

describe("permisos", () => {
  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "%s recibe 403 en todos los endpoints de usuarios y el servicio no se toca",
    async (rol) => {
      usarSesion(sesion(rol));
      for (const llamar of Object.values(llamadas)) {
        const res = await llamar();
        expect(res.status).toBe(403);
      }
      expect(servicio.listarUsuarios).not.toHaveBeenCalled();
      expect(servicio.crearUsuario).not.toHaveBeenCalled();
      expect(servicio.actualizarUsuario).not.toHaveBeenCalled();
      expect(servicio.restablecerPassword).not.toHaveBeenCalled();
    },
  );

  it("sin sesión → 401", async () => {
    usarSesion(null);
    for (const llamar of Object.values(llamadas)) {
      expect((await llamar()).status).toBe(401);
    }
  });

  it("un ADMIN desactivado (cookie leída de BD) → 401 USUARIO_DESACTIVADO", async () => {
    usarSesion(sesion("ADMIN", { activo: false }));
    const res = await llamadas.GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ codigo: "USUARIO_DESACTIVADO" });
  });

  it("un ADMIN con clave temporal → 403 DEBE_CAMBIAR_PASSWORD (confirmado en BD)", async () => {
    usarSesion(sesion("ADMIN", { debeCambiarPassword: true }));
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ debeCambiarPassword: true } as never);
    const res = await llamadas.GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Tu contraseña es temporal: cámbiala para continuar.",
      codigo: "DEBE_CAMBIAR_PASSWORD",
    });
  });
});

describe("POST /api/usuarios", () => {
  it("crea y devuelve la clave temporal una vez (201)", async () => {
    vi.mocked(servicio.crearUsuario).mockResolvedValue({
      usuario: { id: "u9" } as never,
      passwordTemporal: "Abcd-Efgh-Jkmn",
    });
    const res = await POST(
      req("/api/usuarios", {
        method: "POST",
        body: { name: " Ana Pérez ", email: " Ana@Galcomex.COM ", rol: "OPERATIVO" },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ passwordTemporal: "Abcd-Efgh-Jkmn" });
    expect(servicio.crearUsuario).toHaveBeenCalledWith(
      { name: "Ana Pérez", email: "ana@galcomex.com", rol: "OPERATIVO" },
      ADMIN_ID,
    );
  });

  it("rechaza correo inválido, rol desconocido, campos extra (p. ej. password) y JSON roto", async () => {
    const casos: unknown[] = [
      { name: "Ana", email: "no-es-correo", rol: "OPERATIVO" },
      { name: "Ana", email: "a@b.co", rol: "JEFE" },
      { name: "Ana", email: "a@b.co", rol: "OPERATIVO", password: "x" },
      { name: "A", email: "a@b.co", rol: "OPERATIVO" },
    ];
    for (const body of casos) {
      const res = await POST(req("/api/usuarios", { method: "POST", body }));
      expect(res.status).toBe(400);
    }
    const roto = await POST(req("/api/usuarios", { method: "POST", raw: "{no-json" }));
    expect(roto.status).toBe(400);
    expect(servicio.crearUsuario).not.toHaveBeenCalled();
  });

  it("correo repetido → 409 con el mensaje del dominio", async () => {
    vi.mocked(servicio.crearUsuario).mockRejectedValue(
      new servicio.EmailDuplicadoError("Ya existe un usuario con el correo a@b.co"),
    );
    const res = await llamadas.POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Ya existe un usuario con el correo a@b.co" });
  });
});

describe("PATCH /api/usuarios/[id]", () => {
  it("pasa solo los cambios validados al servicio", async () => {
    vi.mocked(servicio.actualizarUsuario).mockResolvedValue({ id: "u1" } as never);
    const res = await PATCH(
      req("/api/usuarios/u1", { method: "PATCH", body: { rol: "SOCIO", activo: true } }),
      ctx("u1"),
    );
    expect(res.status).toBe(200);
    expect(servicio.actualizarUsuario).toHaveBeenCalledWith(
      "u1",
      { rol: "SOCIO", activo: true },
      ADMIN_ID,
    );
  });

  it("rechaza cuerpo vacío, email (no editable) y activo no booleano", async () => {
    for (const body of [{}, { email: "x@y.co" }, { activo: "no" }]) {
      const res = await PATCH(req("/api/usuarios/u1", { method: "PATCH", body }), ctx("u1"));
      expect(res.status).toBe(400);
    }
    expect(servicio.actualizarUsuario).not.toHaveBeenCalled();
  });

  it("una regla de negocio (último ADMIN, auto-desactivación) → 422", async () => {
    vi.mocked(servicio.actualizarUsuario).mockRejectedValue(
      new servicio.ReglaUsuarioError("No puedes desactivar tu propio usuario."),
    );
    const res = await llamadas.PATCH();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "No puedes desactivar tu propio usuario." });
  });
});

describe("POST /api/usuarios/[id]/reset-password", () => {
  it("sin cuerpo genera clave temporal y la devuelve", async () => {
    vi.mocked(servicio.restablecerPassword).mockResolvedValue({ passwordTemporal: "Abcd-Efgh-Jkmn" });
    const res = await resetPOST(
      req("/api/usuarios/u1/reset-password", { method: "POST", raw: "" }),
      ctx("u1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, passwordTemporal: "Abcd-Efgh-Jkmn" });
    expect(servicio.restablecerPassword).toHaveBeenCalledWith("u1", ADMIN_ID, undefined);
  });

  it("mantiene el cuerpo `{ nuevaPassword }` de la tool MCP, ahora con mínimo 10", async () => {
    vi.mocked(servicio.restablecerPassword).mockResolvedValue({ passwordTemporal: null });
    const ok = await resetPOST(
      req("/api/usuarios/u1/reset-password", {
        method: "POST",
        body: { nuevaPassword: "ClaveDelAdmin-2026" },
      }),
      ctx("u1"),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(servicio.restablecerPassword).toHaveBeenCalledWith("u1", ADMIN_ID, "ClaveDelAdmin-2026");

    const corta = await resetPOST(
      req("/api/usuarios/u1/reset-password", { method: "POST", body: { nuevaPassword: "12345678" } }),
      ctx("u1"),
    );
    expect(corta.status).toBe(400);
    expect(await corta.json()).toMatchObject({
      details: [{ campo: "nuevaPassword", mensaje: "La contraseña debe tener al menos 10 caracteres." }],
    });
  });

  it("usuario inexistente → 404", async () => {
    vi.mocked(servicio.restablecerPassword).mockRejectedValue(
      new servicio.UsuarioNoEncontradoError(),
    );
    expect((await llamadas.RESET()).status).toBe(404);
  });
});
