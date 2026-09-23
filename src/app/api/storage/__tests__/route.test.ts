/**
 * Tests de los fixes de seguridad (2026-09-22) sobre /api/storage:
 *
 *  - DELETE ahora es SOLO ADMIN (antes REVISOR/OPERATIVO también podían
 *    mandar a la papelera cualquier archivo con solo conocer su storageKey).
 *  - DELETE rechaza (409) un storageKey que pertenece a un Documento no
 *    eliminado: esos se borran por el flujo de documentos del trámite, que
 *    valida permisos por rol y deja su propio AuditLog.
 *  - DELETE exitoso deja un AuditLog ("StorageObject" / "DELETE").
 *  - GET (listado) y POST (downloadUrl) rechazan la papelera (`deleted/`)
 *    para cualquier rol que no sea ADMIN — igual que ya hacía el explorador
 *    de archivos (lib/storage/explorador.ts#puedeVerPrefijo).
 *
 * Mismo harness que src/app/api/__tests__/idor-regresion.test.ts: se mockean
 * next/headers, @/lib/auth/auth, @/lib/db/prisma y las funciones de I/O de
 * @/lib/storage; requireRole corre con su lógica real.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

// ── Mocks tempranos ────────────────────────────────────────────────────────────

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

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    documento: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    listStorageObjects: vi.fn().mockResolvedValue([]),
    createPresignedDownloadUrl: vi.fn().mockResolvedValue({ storageKey: "x", url: "http://x", method: "GET", expiresInSeconds: 600 }),
    createPresignedUploadUrl: vi.fn(),
    softDeleteStorageObject: vi.fn().mockResolvedValue({ storageKey: "x", deletedStorageKey: "deleted/x", deletedAt: new Date() }),
  };
});

// ── Importaciones post-mock ────────────────────────────────────────────────────

import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { DELETE, GET, POST } from "@/app/api/storage/route";
import { createPresignedDownloadUrl, listStorageObjects, softDeleteStorageObject } from "@/lib/storage";

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

function makeRequest(url: string, options?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, options);
}

describe("DELETE /api/storage — solo ADMIN, protege documentos activos, deja AuditLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("REVISOR → 403 (ya no puede borrar objetos de la bodega)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

    const res = await DELETE(
      makeRequest("/api/storage", {
        method: "DELETE",
        body: JSON.stringify({ storageKey: "tramites/DO-1/OTRO/a.pdf" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(403);
    expect(softDeleteStorageObject).not.toHaveBeenCalled();
  });

  it("OPERATIVO → 403", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));

    const res = await DELETE(
      makeRequest("/api/storage", {
        method: "DELETE",
        body: JSON.stringify({ storageKey: "tramites/DO-1/OTRO/a.pdf" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(403);
  });

  it("ADMIN pero el storageKey pertenece a un Documento activo → 409, no lo manda a la papelera", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    vi.mocked(prisma.documento.findFirst).mockResolvedValueOnce({ id: "doc-1", tramiteId: "t-1" } as never);

    const res = await DELETE(
      makeRequest("/api/storage", {
        method: "DELETE",
        body: JSON.stringify({ storageKey: "tramites/DO-1/OTRO/a.pdf" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(409);
    expect(softDeleteStorageObject).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("ADMIN con storageKey libre → soft-delete + AuditLog StorageObject/DELETE", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    vi.mocked(prisma.documento.findFirst).mockResolvedValueOnce(null);

    const res = await DELETE(
      makeRequest("/api/storage", {
        method: "DELETE",
        body: JSON.stringify({ storageKey: "tramites/DO-1/OTRO/a.pdf" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(200);
    expect(softDeleteStorageObject).toHaveBeenCalledWith({
      storageKey: "tramites/DO-1/OTRO/a.pdf",
      deletedBy: "user-test-id",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entidad: "StorageObject",
          accion: "DELETE",
          usuarioId: "user-test-id",
        }),
      }),
    );
  });
});

describe("GET /api/storage — la papelera (deleted/) solo la ve ADMIN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("REVISOR con prefix=deleted/ → 403, no llega a listar", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

    const res = await GET(makeRequest("/api/storage?prefix=deleted%2F"));

    expect(res.status).toBe(403);
    expect(listStorageObjects).not.toHaveBeenCalled();
  });

  it("OPERATIVO con includeDeleted=true → 403", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));

    const res = await GET(makeRequest("/api/storage?includeDeleted=true"));

    expect(res.status).toBe(403);
    expect(listStorageObjects).not.toHaveBeenCalled();
  });

  it("ADMIN con prefix=deleted/ → sí puede listar", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const res = await GET(makeRequest("/api/storage?prefix=deleted%2F"));

    expect(res.status).toBe(200);
    expect(listStorageObjects).toHaveBeenCalled();
  });

  it("REVISOR sin tocar deleted/ → listado normal, sin restricción", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

    const res = await GET(makeRequest("/api/storage?prefix=tramites%2F"));

    expect(res.status).toBe(200);
    expect(listStorageObjects).toHaveBeenCalled();
  });
});

describe("POST /api/storage { action: downloadUrl } — no ADMIN no descarga de la papelera", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OPERATIVO pidiendo un storageKey deleted/... → 403", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));

    const res = await POST(
      makeRequest("/api/storage", {
        method: "POST",
        body: JSON.stringify({ action: "downloadUrl", storageKey: "deleted/2026-09-22/tramites/DO-1/a.pdf" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(403);
    expect(createPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("ADMIN pidiendo un storageKey deleted/... → sí genera el enlace", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const res = await POST(
      makeRequest("/api/storage", {
        method: "POST",
        body: JSON.stringify({ action: "downloadUrl", storageKey: "deleted/2026-09-22/tramites/DO-1/a.pdf" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(200);
    expect(createPresignedDownloadUrl).toHaveBeenCalled();
  });
});
