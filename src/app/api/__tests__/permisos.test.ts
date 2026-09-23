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

vi.mock("@/lib/anticipos/service", () => ({
  crearAnticipo: vi.fn(),
  listarAnticipos: vi.fn().mockResolvedValue([]),
  aplicarAnticipo: vi.fn(),
  eliminarAplicacion: vi.fn(),
  SoporteAnticipoRequeridoError: class SoporteAnticipoRequeridoError extends Error {
    status = 400;
  },
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
import { crearAnticipo, aplicarAnticipo, eliminarAplicacion } from "@/lib/anticipos/service";
import { GET as clienteByIdGET, PATCH as clienteByIdPATCH } from "@/app/api/clientes/[id]/route";
import { GET as clientesGET } from "@/app/api/clientes/route";
import { PATCH as borradorPATCH } from "@/app/api/borradores/[id]/route";
import { POST as anticiposPOST } from "@/app/api/anticipos/route";
import { POST as aplicacionesPOST } from "@/app/api/anticipos/[id]/aplicaciones/route";
import { DELETE as aplicacionDELETE } from "@/app/api/anticipos/[id]/aplicaciones/[aplicacionId]/route";

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
        ciudad: null,
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

  // ── 6. OPERATIVO — anticipos: crear/aplicar/quitar aplicación ───────────────
  //
  // Decisión del dueño 2026-09-22: Karina (OPERATIVO) SÍ puede registrar
  // anticipos. Antes POST /api/anticipos era requireRole(["ADMIN"]) y el
  // botón de la UI quedaba en 403 (gap documentado desde el 26-ago). Se abrió
  // crear, aplicar y quitar aplicación a ADMIN/OPERATIVO; verificar mantiene
  // su regla propia (no se toca aquí).

  describe("OPERATIVO — anticipos: crear/aplicar/quitar aplicación ya no dan 403", () => {
    it("POST /api/anticipos con OPERATIVO → ya NO es 403 (antes bloqueado)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));
      vi.mocked(crearAnticipo).mockResolvedValueOnce({
        id: "ant-1",
        clienteId: "cliente-1",
        monto: 1_000_000n,
        fecha: new Date("2026-01-01"),
        tipoRecaudo: "BANCOLOMBIA",
        costoRecaudo: 0n,
        soporteKey: "soporte.pdf",
        verificadoBanco: false,
        estado: "BORRADOR",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const res = await anticiposPOST(
        makeRequest("/api/anticipos", {
          method: "POST",
          body: JSON.stringify({
            clienteId: "cliente-1",
            monto: "1000000",
            fecha: "2026-01-01",
            tipoRecaudo: "BANCOLOMBIA",
            soporteKey: "soporte.pdf",
          }),
          headers: { "content-type": "application/json" },
        }),
      );

      expect(res.status).toBe(201);
      expect(crearAnticipo).toHaveBeenCalledTimes(1);
    });

    it("POST /api/anticipos con REVISOR → sigue en 403 (no se amplió a REVISOR)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

      const res = await anticiposPOST(
        makeRequest("/api/anticipos", {
          method: "POST",
          body: JSON.stringify({
            clienteId: "cliente-1",
            monto: "1000000",
            fecha: "2026-01-01",
            tipoRecaudo: "BANCOLOMBIA",
            soporteKey: "soporte.pdf",
          }),
          headers: { "content-type": "application/json" },
        }),
      );

      expect(res.status).toBe(403);
      expect(crearAnticipo).not.toHaveBeenCalled();
    });

    it("POST /api/anticipos/[id]/aplicaciones con OPERATIVO → ya NO es 403", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));
      vi.mocked(aplicarAnticipo).mockResolvedValueOnce({
        ok: true,
        aplicacion: {
          id: "apl-1",
          anticipoId: "ant-1",
          tramiteId: "tram-1",
          montoAplicado: 500_000n,
          createdAt: new Date(),
        },
      });

      const res = await aplicacionesPOST(
        makeRequest("/api/anticipos/ant-1/aplicaciones", {
          method: "POST",
          body: JSON.stringify({ tramiteId: "tram-1", montoAplicado: "500000" }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("ant-1"),
      );

      expect(res.status).toBe(201);
      expect(aplicarAnticipo).toHaveBeenCalledTimes(1);
    });

    it("DELETE /api/anticipos/[id]/aplicaciones/[aplicacionId] con OPERATIVO → ya NO es 403", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));
      vi.mocked(eliminarAplicacion).mockResolvedValueOnce({
        id: "apl-1",
        anticipoId: "ant-1",
        tramiteId: "tram-1",
        montoAplicado: 500_000n,
        createdAt: new Date(),
      } as never);

      const res = await aplicacionDELETE(
        makeRequest("/api/anticipos/ant-1/aplicaciones/apl-1", { method: "DELETE" }),
        { params: Promise.resolve({ id: "ant-1", aplicacionId: "apl-1" }) },
      );

      expect(res.status).toBe(200);
      expect(eliminarAplicacion).toHaveBeenCalledTimes(1);
    });
  });

  // ── 7. Rate limiting — hallazgo documental ───────────────────────────────────

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
