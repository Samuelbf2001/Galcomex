/**
 * GET /api/facturacion/borradores — consulta por lote de borradores.
 *
 * Harness: igual que src/app/api/__tests__/idor-regresion.test.ts — se mockean
 * next/headers, @/lib/auth/auth y @/lib/db/prisma; requireRole y
 * resolverTramiteConPermiso corren con su lógica real. Se mockea además
 * @/lib/borradores/service (ensureBorrador / listarBorradores) porque aquí se
 * prueba la orquestación del lote, no el motor.
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

vi.mock("@/lib/borradores/service", () => ({
  ensureBorrador: vi.fn(),
  listarBorradores: vi.fn(),
}));

// ── Importaciones post-mock ────────────────────────────────────────────────────

import { auth } from "@/lib/auth/auth";
import { ensureBorrador, listarBorradores } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { GET as loteGET } from "@/app/api/facturacion/borradores/route";
import { GET as individualGET } from "@/app/api/tramites/[id]/borrador/route";

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

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/facturacion/borradores${query}`);
}

/** Trámites "en BD": id → tipo de cliente. Los ids ausentes no existen. */
const TRAMITES: Record<string, "PROPIO" | "SOCIO_LM"> = {
  "tr-propio": "PROPIO",
  "tr-socio": "SOCIO_LM",
  "tr-explota": "PROPIO",
};

function borradorFake(tramiteId: string) {
  return {
    id: `b-${tramiteId}`,
    tramiteId,
    estado: "BORRADOR",
    comision: 150_000n,
    totalFactura: 1_234_567n,
    lineasRevision: [],
    factura: null,
  };
}

function instalarFindUnique() {
  vi.mocked(prisma.tramiteDO.findUnique).mockImplementation(((args: {
    where: { id: string };
  }) => {
    const tipo = TRAMITES[args.where.id];
    return Promise.resolve(tipo ? { id: args.where.id, cliente: { tipo } } : null);
  }) as never);
}

function instalarListar() {
  vi.mocked(listarBorradores).mockImplementation((async (tramiteId: string) => {
    if (tramiteId === "tr-explota") {
      throw new Error("detalle interno que NO debe filtrarse");
    }
    return [borradorFake(tramiteId)];
  }) as never);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/facturacion/borradores (lote)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(ensureBorrador).mockResolvedValue(undefined);
    instalarFindUnique();
    instalarListar();
  });

  it("sin sesión → 401", async () => {
    const res = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    expect(res.status).toBe(401);
  });

  it("OPERATIVO → 403 (mismos roles que el GET individual)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));
    const res = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    expect(res.status).toBe(403);
    expect(listarBorradores).not.toHaveBeenCalled();
  });

  it("sin tramiteIds → 400 con detalle Zod", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    const res = await loteGET(makeRequest(""));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe("Payload invalido");
  });

  it("tramiteIds vacío o solo comas → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    const res = await loteGET(makeRequest("?tramiteIds=,%20,"));
    expect(res.status).toBe(400);
  });

  it("más de 100 ids → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    const ids = Array.from({ length: 101 }, (_, i) => `tr-${i}`).join(",");
    const res = await loteGET(makeRequest(`?tramiteIds=${ids}`));
    expect(res.status).toBe(400);
    expect(listarBorradores).not.toHaveBeenCalled();
  });

  it("ADMIN: cada id lleva su payload o su error, sin bloquear al resto", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const res = await loteGET(
      makeRequest("?tramiteIds=tr-propio,no-existe,tr-explota,tr-socio"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const body = await json(res);
    const porTramite = body.porTramite as Record<string, Record<string, unknown>>;

    expect(Object.keys(porTramite).sort()).toEqual(
      ["no-existe", "tr-explota", "tr-propio", "tr-socio"].sort(),
    );

    // Payload idéntico al individual: { borradores } con BigInt → string.
    expect(porTramite["tr-propio"]).toEqual({
      borradores: [
        {
          id: "b-tr-propio",
          tramiteId: "tr-propio",
          estado: "BORRADOR",
          comision: "150000",
          totalFactura: "1234567",
          lineasRevision: [],
          factura: null,
        },
      ],
    });
    expect(porTramite["tr-socio"]).toEqual({
      borradores: [expect.objectContaining({ id: "b-tr-socio" })],
    });

    // Mismos mensajes que el individual.
    expect(porTramite["no-existe"]).toEqual({ error: "Trámite no encontrado" });
    // Error inesperado → mensaje genérico, sin filtrar el detalle interno.
    expect(porTramite["tr-explota"]).toEqual({
      error: "Error al cargar los borradores del trámite",
    });

    // Red de seguridad ensureBorrador se aplicó a los trámites con permiso.
    expect(ensureBorrador).toHaveBeenCalledWith("tr-propio", "user-test-id");
    expect(ensureBorrador).toHaveBeenCalledWith("tr-socio", "user-test-id");
    expect(ensureBorrador).not.toHaveBeenCalledWith("no-existe", expect.anything());
  });

  it("SOCIO: trámite de cliente PROPIO → error 'No autorizado'; SOCIO_LM → payload", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

    const res = await loteGET(makeRequest("?tramiteIds=tr-propio,tr-socio"));
    expect(res.status).toBe(200);

    const porTramite = (await json(res)).porTramite as Record<string, Record<string, unknown>>;
    expect(porTramite["tr-propio"]).toEqual({ error: "No autorizado" });
    expect(porTramite["tr-socio"]).toEqual({
      borradores: [expect.objectContaining({ id: "b-tr-socio" })],
    });
    // Ni ensureBorrador ni listar se ejecutan para el trámite vetado.
    expect(ensureBorrador).not.toHaveBeenCalledWith("tr-propio", expect.anything());
    expect(listarBorradores).not.toHaveBeenCalledWith("tr-propio");
  });

  it("ids duplicados se colapsan: una sola carga por trámite", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const res = await loteGET(
      makeRequest("?tramiteIds=tr-propio,tr-propio,%20tr-socio%20,tr-socio"),
    );
    expect(res.status).toBe(200);

    const porTramite = (await json(res)).porTramite as Record<string, unknown>;
    expect(Object.keys(porTramite).sort()).toEqual(["tr-propio", "tr-socio"]);
    expect(listarBorradores).toHaveBeenCalledTimes(2);
  });

  it("procesa en grupos de 10: nunca más de 10 cargas en vuelo", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const ids = Array.from({ length: 25 }, (_, i) => `lote-${i}`);
    for (const id of ids) TRAMITES[id] = "PROPIO";

    let enVuelo = 0;
    let maxEnVuelo = 0;
    vi.mocked(listarBorradores).mockImplementation((async (tramiteId: string) => {
      enVuelo += 1;
      maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      await new Promise((resolve) => setTimeout(resolve, 2));
      enVuelo -= 1;
      return [borradorFake(tramiteId)];
    }) as never);

    try {
      const res = await loteGET(makeRequest(`?tramiteIds=${ids.join(",")}`));
      expect(res.status).toBe(200);

      const porTramite = (await json(res)).porTramite as Record<string, unknown>;
      expect(Object.keys(porTramite)).toHaveLength(25);
      expect(listarBorradores).toHaveBeenCalledTimes(25);
      expect(maxEnVuelo).toBeLessThanOrEqual(10);
      expect(maxEnVuelo).toBeGreaterThan(1);
    } finally {
      for (const id of ids) delete TRAMITES[id];
    }
  });

  it("paridad: para el mismo trámite, el lote devuelve exactamente el body del GET individual", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

    const individual = await individualGET(
      new NextRequest("http://localhost/api/tramites/tr-propio/borrador"),
      { params: Promise.resolve({ id: "tr-propio" }) },
    );
    expect(individual.status).toBe(200);
    const bodyIndividual = await json(individual);

    const lote = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    const porTramite = (await json(lote)).porTramite as Record<string, unknown>;

    expect(porTramite["tr-propio"]).toEqual(bodyIndividual);
  });

  it("paridad de errores: el GET individual sigue respondiendo 404 / 403 con el mismo mensaje", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

    const noExiste = await individualGET(
      new NextRequest("http://localhost/api/tramites/no-existe/borrador"),
      { params: Promise.resolve({ id: "no-existe" }) },
    );
    expect(noExiste.status).toBe(404);
    expect(await json(noExiste)).toEqual({ error: "Trámite no encontrado" });

    const vetado = await individualGET(
      new NextRequest("http://localhost/api/tramites/tr-propio/borrador"),
      { params: Promise.resolve({ id: "tr-propio" }) },
    );
    expect(vetado.status).toBe(403);
    expect(await json(vetado)).toEqual({ error: "No autorizado" });
  });
});
