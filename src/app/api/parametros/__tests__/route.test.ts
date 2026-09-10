/**
 * Tests de permisos y validación — PATCH /api/parametros/[clave]
 *
 * Estrategia de mock (igual que src/app/api/__tests__/permisos.test.ts):
 *   - vi.mock("@/lib/auth/auth") → sesión controlada.
 *   - vi.mock("next/headers")    → getCurrentSession no falla fuera de request context.
 *   - requireRole REAL ejecuta su lógica de autorización.
 *   - @/lib/parametros/service se mockea para aislar el test de autorización/
 *     validación de la BD.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

vi.mock("@/lib/parametros/service", () => ({
  actualizarParametro: vi.fn(),
  ParametroNoEncontradoError: class ParametroNoEncontradoError extends Error {
    status = 404;
    constructor(clave: string) {
      super(`Parámetro '${clave}' no encontrado`);
      this.name = "ParametroNoEncontradoError";
    }
  },
  ParametroSiigoProtegidoError: class ParametroSiigoProtegidoError extends Error {
    status = 400;
    constructor(clave: string) {
      super(`El parámetro '${clave}' es de integración Siigo`);
      this.name = "ParametroSiigoProtegidoError";
    }
  },
}));

import { auth } from "@/lib/auth/auth";
import {
  ParametroNoEncontradoError,
  ParametroSiigoProtegidoError,
  actualizarParametro,
} from "@/lib/parametros/service";
import { PATCH } from "@/app/api/parametros/[clave]/route";

function makeSession(rol: Rol) {
  return {
    user: {
      id: "user-test-id",
      rol,
      email: "test@test.com",
      name: "Test User",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-test-id",
      userId: "user-test-id",
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "mock-token",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/parametros/X", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function routeCtx(clave: string) {
  return { params: Promise.resolve({ clave }) };
}

describe("PATCH /api/parametros/[clave]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  it("sin sesión → 401", async () => {
    const res = await PATCH(makeRequest({ valor: "1" }), routeCtx("X"));
    expect(res.status).toBe(401);
    expect(actualizarParametro).not.toHaveBeenCalled();
  });

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as Rol[])(
    "rol %s (no-ADMIN) → 403",
    async (rol) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSession(rol) as any,
      );
      const res = await PATCH(makeRequest({ valor: "1" }), routeCtx("X"));
      expect(res.status).toBe(403);
      expect(actualizarParametro).not.toHaveBeenCalled();
    },
  );

  it("ADMIN con valor vacío → 400 (Zod)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSession("ADMIN") as any,
    );
    const res = await PATCH(makeRequest({ valor: "" }), routeCtx("X"));
    expect(res.status).toBe(400);
    expect(actualizarParametro).not.toHaveBeenCalled();
  });

  it("ADMIN con payload válido → 200 y delega en el servicio", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSession("ADMIN") as any,
    );
    vi.mocked(actualizarParametro).mockResolvedValue({
      id: "1",
      clave: "X",
      valor: "nuevo",
      descripcion: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await PATCH(makeRequest({ valor: "nuevo" }), routeCtx("X"));
    expect(res.status).toBe(200);
    expect(actualizarParametro).toHaveBeenCalledWith("X", "nuevo", "user-test-id");
    const body = await res.json();
    expect(body.parametro.valor).toBe("nuevo");
  });

  it("servicio lanza ParametroNoEncontradoError → 404", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSession("ADMIN") as any,
    );
    vi.mocked(actualizarParametro).mockRejectedValue(
      new ParametroNoEncontradoError("X"),
    );

    const res = await PATCH(makeRequest({ valor: "nuevo" }), routeCtx("X"));
    expect(res.status).toBe(404);
  });

  it("servicio lanza ParametroSiigoProtegidoError → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSession("ADMIN") as any,
    );
    vi.mocked(actualizarParametro).mockRejectedValue(
      new ParametroSiigoProtegidoError("SIIGO_VENDEDOR_ID"),
    );

    const res = await PATCH(
      makeRequest({ valor: "nuevo" }),
      routeCtx("SIIGO_VENDEDOR_ID"),
    );
    expect(res.status).toBe(400);
  });
});
