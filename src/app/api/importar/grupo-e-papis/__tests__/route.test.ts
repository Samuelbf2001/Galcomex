// @vitest-environment node
/**
 * Permisos de POST /api/importar/grupo-e-papis (ADMIN-only).
 *
 * Env `node`: el parseo de `request.formData()` usa los globals de undici
 * (File/Blob); bajo jsdom el `instanceof Blob` falla por usar otro realm.
 *
 * Estrategia de mock (igual a src/app/api/__tests__/permisos.test.ts):
 *   - vi.mock("@/lib/auth/auth")  → auth.api.getSession devuelve sesión controlada.
 *   - vi.mock("next/headers")     → getCurrentSession no falla fuera de request context.
 *   - requireRole REAL ejecuta su lógica de autorización.
 *   - prisma, el engine y XLSX se mockean para aislar el test de la autorización.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

// ── Mocks tempranos ────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    cliente: {
      findUnique: vi.fn().mockResolvedValue({ id: "cli-1", nombre: "Cliente Test" }),
    },
  },
}));

vi.mock("@/lib/import/grupo-e-papis", () => ({
  importarWorkbookGrupoEPapis: vi.fn().mockResolvedValue({
    clienteId: "cli-1",
    totalHojas: 0,
    importadas: 0,
    omitidas: 0,
    errores: 0,
    hojas: [],
  }),
}));

vi.mock("xlsx", () => ({
  read: vi.fn().mockReturnValue({ SheetNames: [], Sheets: {} }),
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

// ── Importaciones post-mock ────────────────────────────────────────────────────

import { auth } from "@/lib/auth/auth";
import { importarWorkbookGrupoEPapis } from "@/lib/import/grupo-e-papis";
import { POST } from "@/app/api/importar/grupo-e-papis/route";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function makeRequest(): NextRequest {
  const form = new FormData();
  form.set("clienteId", "cli-1");
  form.set("dryRun", "true");
  form.set(
    "file",
    new File([new Uint8Array([1, 2, 3])], "GRUPO E PAPIS 2026.xlsm", {
      type: "application/vnd.ms-excel.sheet.macroEnabled.12",
    }),
  );

  return new NextRequest("http://localhost/api/importar/grupo-e-papis", {
    method: "POST",
    body: form,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/importar/grupo-e-papis — permisos (ADMIN-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(importarWorkbookGrupoEPapis).mockResolvedValue({
      clienteId: "cli-1",
      totalHojas: 0,
      importadas: 0,
      omitidas: 0,
      errores: 0,
      hojas: [],
    });
  });

  it("sin sesión → 401 y no invoca el engine", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "No autenticado" });
    expect(importarWorkbookGrupoEPapis).not.toHaveBeenCalled();
  });

  it.each<Rol>(["OPERATIVO", "REVISOR", "SOCIO"])(
    "rol %s (no ADMIN) → 403 y no invoca el engine",
    async (rol) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession(rol));

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "No autorizado" });
      expect(importarWorkbookGrupoEPapis).not.toHaveBeenCalled();
    },
  );

  it("ADMIN → autorizado (status < 400, invoca el engine)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN"));

    const res = await POST(makeRequest());

    expect(res.status).toBeLessThan(400);
    expect(importarWorkbookGrupoEPapis).toHaveBeenCalledTimes(1);
    expect(importarWorkbookGrupoEPapis).toHaveBeenCalledWith(
      expect.objectContaining({
        clienteId: "cli-1",
        usuarioId: "user-test-id",
        dryRun: true,
      }),
    );
  });
});
