/**
 * Tests de regresión IDOR (G1) — 2026-08-24
 *
 * El 2026-08-24 se corrigieron 4 endpoints que permitían a SOCIO acceder a
 * datos ajenos:
 *   - GET/POST/DELETE /api/storage
 *       → ahora requireRole(["ADMIN", "REVISOR", "OPERATIVO"]); SOCIO queda
 *         fuera por completo (403), ya no puede pedir URLs firmadas de
 *         cualquier storageKey.
 *   - GET /api/tramites/[id]/documentos
 *       → ahora exige resolverTramiteConPermiso(id, rol): un SOCIO solo
 *         accede si el cliente del trámite es SOCIO_LM.
 *   - GET /api/tramites/[id]/documentos/[documentoId]
 *       → mismo gate + verificación explícita de que el documento
 *         encontrado pertenece al trámite de la URL (evita pedir un
 *         documento ajeno pasando el tramiteId propio en la ruta).
 *   - PUT /api/borradores/[id]/comentarios
 *       → ahora resuelve el tramiteId del borrador y aplica el mismo gate
 *         resolverTramiteConPermiso.
 *
 * Harness: igual que src/app/api/__tests__/permisos.test.ts — se mockean
 * next/headers, @/lib/auth/auth y @/lib/db/prisma, y se invocan los
 * handlers de ruta directamente con un NextRequest construido a mano.
 * requireRole y resolverTramiteConPermiso corren con su lógica real.
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
    tramiteDO: { findUnique: vi.fn() },
    documento: { findUnique: vi.fn() },
    borradorFactura: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
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
import {
  GET as storageGET,
  POST as storagePOST,
  DELETE as storageDELETE,
} from "@/app/api/storage/route";
import { GET as documentosGET } from "@/app/api/tramites/[id]/documentos/route";
import { GET as documentoByIdGET } from "@/app/api/tramites/[id]/documentos/[documentoId]/route";
import { PUT as comentariosPUT } from "@/app/api/borradores/[id]/comentarios/route";

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

function routeCtxDoc(id: string, documentoId: string) {
  return { params: Promise.resolve({ id, documentoId }) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Regresión IDOR (G1, fix 2026-08-24) — SOCIO no accede a datos ajenos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  // ── /api/storage — ahora solo ADMIN/REVISOR/OPERATIVO ───────────────────────

  describe("GET/POST/DELETE /api/storage — SOCIO → 403", () => {
    it("GET → 403 No autorizado", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

      const res = await storageGET(makeRequest("/api/storage"));

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "No autorizado" });
    });

    it("POST (uploadUrl) → 403 antes de generar cualquier URL firmada", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

      const res = await storagePOST(
        makeRequest("/api/storage", {
          method: "POST",
          body: JSON.stringify({ action: "uploadUrl" }),
          headers: { "content-type": "application/json" },
        }),
      );

      expect(res.status).toBe(403);
    });

    it("DELETE → 403 antes de tocar el storage", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

      const res = await storageDELETE(
        makeRequest("/api/storage", {
          method: "DELETE",
          body: JSON.stringify({ storageKey: "cualquier-key" }),
          headers: { "content-type": "application/json" },
        }),
      );

      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/tramites/[id]/documentos ───────────────────────────────────────

  describe("GET /api/tramites/[id]/documentos", () => {
    it("SOCIO sobre trámite de cliente PROPIO (ajeno) → 403", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.tramiteDO.findUnique).mockResolvedValueOnce({
        id: "tramite-propio",
        cliente: { tipo: "PROPIO" },
      } as never);

      const res = await documentosGET(
        makeRequest("/api/tramites/tramite-propio/documentos"),
        routeCtx("tramite-propio"),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "No autorizado" });
    });

    it("SOCIO sobre trámite inexistente → 404 (no filtra existencia)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.tramiteDO.findUnique).mockResolvedValueOnce(null);

      const res = await documentosGET(
        makeRequest("/api/tramites/no-existe/documentos"),
        routeCtx("no-existe"),
      );

      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/tramites/[id]/documentos/[documentoId] ─────────────────────────

  describe("GET /api/tramites/[id]/documentos/[documentoId]", () => {
    it("SOCIO sobre trámite de cliente PROPIO (ajeno) → 403 (no llega a resolver el documento)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.tramiteDO.findUnique).mockResolvedValueOnce({
        id: "tramite-propio",
        cliente: { tipo: "PROPIO" },
      } as never);

      const res = await documentoByIdGET(
        makeRequest("/api/tramites/tramite-propio/documentos/doc-1"),
        routeCtxDoc("tramite-propio", "doc-1"),
      );

      expect(res.status).toBe(403);
      expect(prisma.documento.findUnique).not.toHaveBeenCalled();
    });

    it("SOCIO en SU trámite (SOCIO_LM) pero documentoId pertenece a OTRO trámite → 404 (IDOR por documentoId)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.tramiteDO.findUnique).mockResolvedValueOnce({
        id: "tramite-socio",
        cliente: { tipo: "SOCIO_LM" },
      } as never);
      vi.mocked(prisma.documento.findUnique).mockResolvedValueOnce({
        tramiteId: "tramite-de-otro-cliente",
      } as never);

      const res = await documentoByIdGET(
        makeRequest("/api/tramites/tramite-socio/documentos/doc-ajeno"),
        routeCtxDoc("tramite-socio", "doc-ajeno"),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "Documento no encontrado" });
    });
  });

  // ── PUT /api/borradores/[id]/comentarios ────────────────────────────────────

  describe("PUT /api/borradores/[id]/comentarios", () => {
    it("SOCIO sobre borrador de trámite de cliente PROPIO (ajeno) → 403", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.borradorFactura.findUnique).mockResolvedValueOnce({
        tramiteId: "tramite-propio",
      } as never);
      vi.mocked(prisma.tramiteDO.findUnique).mockResolvedValueOnce({
        id: "tramite-propio",
        cliente: { tipo: "PROPIO" },
      } as never);

      const res = await comentariosPUT(
        makeRequest("/api/borradores/b1/comentarios", {
          method: "PUT",
          body: JSON.stringify({ comentarios: ["hola"] }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("b1"),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "No autorizado" });
    });

    it("borrador inexistente → 404", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));
      vi.mocked(prisma.borradorFactura.findUnique).mockResolvedValueOnce(null);

      const res = await comentariosPUT(
        makeRequest("/api/borradores/no-existe/comentarios", {
          method: "PUT",
          body: JSON.stringify({ comentarios: [] }),
          headers: { "content-type": "application/json" },
        }),
        routeCtx("no-existe"),
      );

      expect(res.status).toBe(404);
    });
  });
});
