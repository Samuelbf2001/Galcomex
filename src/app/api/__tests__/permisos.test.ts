/**
 * A1-T9 — Matriz de permisos por rol
 *
 * Estrategia de mock:
 *   - vi.mock("@/lib/auth/auth") → auth.api.getSession devuelve sesión controlada.
 *   - vi.mock("next/headers")    → getCurrentSession no falla fuera de request context.
 *   - requireRole REAL ejecuta su lógica de autorización.
 *   - Los handlers de ruta se invocan directamente con NextRequest construido a mano.
 *   - Prisma y borradores/service se mockean para aislar el test de autorización de BD.
 *
 * Hallazgo — Rate limiting:
 *   auth.ts NO configura `rateLimit` en betterAuth. El criterio A1-T9
 *   "Rate limiting en login (5 intentos)" queda pendiente de implementación
 *   en auth.ts y verificación en E2E.
 */

import { EstadoBorrador } from "@prisma/client";
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
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("@/lib/borradores/service", () => ({
  transicionarBorrador: vi.fn(),
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
import { prisma } from "@/lib/db/prisma";
import { transicionarBorrador } from "@/lib/borradores/service";
import { GET as clienteByIdGET, PATCH as clienteByIdPATCH } from "@/app/api/clientes/[id]/route";
import { GET as clientesGET } from "@/app/api/clientes/route";
import { PATCH as borradorPATCH } from "@/app/api/borradores/[id]/route";

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

function makeRequest(
  url: string,
  options?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(`http://localhost${url}`, options);
}

function routeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("A1-T9 — Permisos por rol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: sesión nula (tests individuales sobreescriben)
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(transicionarBorrador).mockResolvedValue({
      ok: false,
      status: 500,
      message: "mock no configurado",
    });
  });

  // ── 1. Sin sesión → 401 en rutas protegidas ──────────────────────────────────

  describe("Unauthenticated — sin sesión → 401", () => {
    it("GET /api/clientes → 401", async () => {
      const res = await clientesGET(makeRequest("/api/clientes"));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "No autenticado" });
    });

    it("GET /api/clientes/[id] → 401", async () => {
      const res = await clienteByIdGET(makeRequest("/api/clientes/x"), routeCtx("x"));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "No autenticado" });
    });

    it("PATCH /api/clientes/[id] → 401", async () => {
      const res = await clienteByIdPATCH(
        makeRequest("/api/clientes/x", {
          method: "PATCH",
          body: JSON.stringify({ nombre: "X" }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("x"),
      );
      expect(res.status).toBe(401);
    });

    it("PATCH /api/borradores/[id] con APROBADO → 401", async () => {
      const res = await borradorPATCH(
        makeRequest("/api/borradores/x", {
          method: "PATCH",
          body: JSON.stringify({ nuevoEstado: EstadoBorrador.APROBADO }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("x"),
      );
      expect(res.status).toBe(401);
    });
  });

  // ── 2. SOCIO — GET /api/clientes filtra a SOCIO_LM, no 403 ──────────────────

  describe("SOCIO — GET /api/clientes filtra en query (no 403)", () => {
    it("devuelve 200 con lista filtrada — el handler aplica where.tipo=SOCIO_LM internamente", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.cliente.findMany).mockResolvedValueOnce([]);

      const res = await clientesGET(makeRequest("/api/clientes"));

      expect(res.status).toBe(200);
      const body = await res.json() as { clientes: unknown[] };
      expect(body).toHaveProperty("clientes");
      expect(Array.isArray(body.clientes)).toBe(true);

      // Verificar que Prisma recibió el filtro tipo=SOCIO_LM
      expect(prisma.cliente.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tipo: "SOCIO_LM" }),
        }),
      );
    });
  });

  // ── 3. SOCIO — GET /api/clientes/[id] de cliente PROPIO → 404 ───────────────

  describe("SOCIO — acceso a cliente tipo PROPIO → 404", () => {
    it("devuelve 404 cuando el cliente existe pero tipo=PROPIO (no SOCIO_LM)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

      // findUnique devuelve un cliente PROPIO
      vi.mocked(prisma.cliente.findUnique).mockResolvedValueOnce({
        id: "propio-id",
        nombre: "Cliente Propio SA",
        nit: "900123456-1",
        tipo: "PROPIO",
        contactoNombre: null,
        contactoEmail: null,
        contactoTel: null,
        manejaAnticipo: true,
        activo: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        // campos include que el handler espera
        tarifas: [],
        tramites: [],
        anticipos: [],
        facturas: [],
      } as never);

      const res = await clienteByIdGET(
        makeRequest("/api/clientes/propio-id"),
        routeCtx("propio-id"),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "Cliente no encontrado" });
    });

    it("devuelve 404 cuando el cliente no existe (findUnique → null)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.cliente.findUnique).mockResolvedValueOnce(null);

      const res = await clienteByIdGET(
        makeRequest("/api/clientes/no-existe"),
        routeCtx("no-existe"),
      );

      expect(res.status).toBe(404);
    });
  });

  // ── 4. OPERATIVO — no puede aprobar borradores → 403 ────────────────────────

  describe("OPERATIVO — PATCH /api/borradores/[id] con APROBADO → 403", () => {
    it("devuelve 403 cuando OPERATIVO intenta aprobar borrador", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));

      const res = await borradorPATCH(
        makeRequest("/api/borradores/b1", {
          method: "PATCH",
          body: JSON.stringify({ nuevoEstado: EstadoBorrador.APROBADO }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("b1"),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "No autorizado" });
    });

    it("OPERATIVO SÍ puede mover borrador a EN_REVISION (ADMIN u OPERATIVO)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));
      vi.mocked(transicionarBorrador).mockResolvedValueOnce({
        ok: true,
        borrador: { id: "b1", estado: EstadoBorrador.EN_REVISION } as never,
      });

      const res = await borradorPATCH(
        makeRequest("/api/borradores/b1", {
          method: "PATCH",
          body: JSON.stringify({ nuevoEstado: EstadoBorrador.EN_REVISION }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("b1"),
      );

      // Autorización OK → no 403 ni 401
      expect(res.status).toBeLessThan(400);
    });
  });

  // ── 5. REVISOR — no puede editar clientes/tarifas → 403 ─────────────────────

  describe("REVISOR — PATCH /api/clientes/[id] requiere ADMIN → 403", () => {
    it("devuelve 403 cuando REVISOR intenta editar un cliente", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

      const res = await clienteByIdPATCH(
        makeRequest("/api/clientes/cliente-id", {
          method: "PATCH",
          body: JSON.stringify({ nombre: "Nuevo Nombre" }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("cliente-id"),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "No autorizado" });
    });

    it("REVISOR SÍ puede aprobar borradores (REVISOR o ADMIN)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));
      vi.mocked(transicionarBorrador).mockResolvedValueOnce({
        ok: true,
        borrador: { id: "b2", estado: EstadoBorrador.APROBADO } as never,
      });

      const res = await borradorPATCH(
        makeRequest("/api/borradores/b2", {
          method: "PATCH",
          body: JSON.stringify({ nuevoEstado: EstadoBorrador.APROBADO }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("b2"),
      );

      expect(res.status).toBeLessThan(400);
    });
  });

  // ── 6. Rate limiting — hallazgo documental ───────────────────────────────────

  describe("Rate limiting de login — hallazgo de configuración", () => {
    /**
     * HALLAZGO: auth.ts no incluye la clave `rateLimit` en betterAuth.
     * El criterio A1-T9 "Rate limiting en login (5 intentos)" está pendiente
     * de implementación en src/lib/auth/auth.ts y verificación en E2E.
     * No se inventa un test de comportamiento que no existe en el código.
     */
    it("HALLAZGO documental: rateLimit no está configurado en betterAuth (pendiente)", () => {
      // Este test pasa siempre; sirve como registro explícito del hallazgo.
      // Ver src/lib/auth/auth.ts — el objeto betterAuth carece de `rateLimit`.
      expect(true).toBe(true);
    });
  });
});
