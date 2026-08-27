/**
 * Tests de permisos y validación — PATCH /api/matrices/recaudo/[tipoRecaudo]
 * y PATCH /api/matrices/pago/[canalPago]
 *
 * Misma estrategia de mock que src/app/api/__tests__/permisos.test.ts:
 *   - vi.mock("@/lib/auth/auth") → sesión controlada, requireRole REAL.
 *   - @/lib/matrices/service se mockea para aislar el test de autorización/
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

vi.mock("@/lib/matrices/service", () => ({
  actualizarCostoRecaudo: vi.fn(),
  actualizarCostoPago: vi.fn(),
  MatrizRecaudoNoEncontradaError: class MatrizRecaudoNoEncontradaError extends Error {
    status = 404;
  },
  MatrizPagoNoEncontradaError: class MatrizPagoNoEncontradaError extends Error {
    status = 404;
  },
  CostoFijoNegativoError: class CostoFijoNegativoError extends Error {
    status = 400;
  },
}));

import { auth } from "@/lib/auth/auth";
import {
  actualizarCostoPago,
  actualizarCostoRecaudo,
} from "@/lib/matrices/service";
import { PATCH as recaudoPATCH } from "@/app/api/matrices/recaudo/[tipoRecaudo]/route";
import { PATCH as pagoPATCH } from "@/app/api/matrices/pago/[canalPago]/route";

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

function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function recaudoCtx(tipoRecaudo: string) {
  return { params: Promise.resolve({ tipoRecaudo }) };
}

function pagoCtx(canalPago: string) {
  return { params: Promise.resolve({ canalPago }) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asSession(rol: Rol): any {
  return makeSession(rol);
}

describe("PATCH /api/matrices/recaudo/[tipoRecaudo]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  it("sin sesión → 401", async () => {
    const res = await recaudoPATCH(
      makeRequest("/api/matrices/recaudo/CAJERO", { costoFijo: "5000" }),
      recaudoCtx("CAJERO"),
    );
    expect(res.status).toBe(401);
    expect(actualizarCostoRecaudo).not.toHaveBeenCalled();
  });

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as Rol[])(
    "rol %s (no-ADMIN) → 403",
    async (rol) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(asSession(rol));
      const res = await recaudoPATCH(
        makeRequest("/api/matrices/recaudo/CAJERO", { costoFijo: "5000" }),
        recaudoCtx("CAJERO"),
      );
      expect(res.status).toBe(403);
      expect(actualizarCostoRecaudo).not.toHaveBeenCalled();
    },
  );

  it("ADMIN con tipoRecaudo inválido → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(asSession("ADMIN"));
    const res = await recaudoPATCH(
      makeRequest("/api/matrices/recaudo/NO_EXISTE", { costoFijo: "5000" }),
      recaudoCtx("NO_EXISTE"),
    );
    expect(res.status).toBe(400);
    expect(actualizarCostoRecaudo).not.toHaveBeenCalled();
  });

  it("ADMIN con costoFijo negativo → 400 (Zod, sin llegar al servicio)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(asSession("ADMIN"));
    const res = await recaudoPATCH(
      makeRequest("/api/matrices/recaudo/CAJERO", { costoFijo: "-100" }),
      recaudoCtx("CAJERO"),
    );
    expect(res.status).toBe(400);
    expect(actualizarCostoRecaudo).not.toHaveBeenCalled();
  });

  it("ADMIN con payload válido → 200 y delega en el servicio con BigInt", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(asSession("ADMIN"));
    vi.mocked(actualizarCostoRecaudo).mockResolvedValue({
      id: "1",
      tipoRecaudo: "CAJERO",
      grupo: "FISICO",
      descripcion: "Cajero",
      costoFijo: 5_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await recaudoPATCH(
      makeRequest("/api/matrices/recaudo/CAJERO", { costoFijo: "5000" }),
      recaudoCtx("CAJERO"),
    );
    expect(res.status).toBe(200);
    expect(actualizarCostoRecaudo).toHaveBeenCalledWith(
      "CAJERO",
      5_000n,
      "user-test-id",
    );
    const body = await res.json();
    expect(body.matrizRecaudo.costoFijo).toBe("5000");
  });
});

describe("PATCH /api/matrices/pago/[canalPago]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  it("sin sesión → 401", async () => {
    const res = await pagoPATCH(
      makeRequest("/api/matrices/pago/PSE", { costoFijo: "0" }),
      pagoCtx("PSE"),
    );
    expect(res.status).toBe(401);
    expect(actualizarCostoPago).not.toHaveBeenCalled();
  });

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as Rol[])(
    "rol %s (no-ADMIN) → 403",
    async (rol) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(asSession(rol));
      const res = await pagoPATCH(
        makeRequest("/api/matrices/pago/PSE", { costoFijo: "0" }),
        pagoCtx("PSE"),
      );
      expect(res.status).toBe(403);
      expect(actualizarCostoPago).not.toHaveBeenCalled();
    },
  );

  it("ADMIN con canalPago inválido → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(asSession("ADMIN"));
    const res = await pagoPATCH(
      makeRequest("/api/matrices/pago/NO_EXISTE", { costoFijo: "0" }),
      pagoCtx("NO_EXISTE"),
    );
    expect(res.status).toBe(400);
    expect(actualizarCostoPago).not.toHaveBeenCalled();
  });

  it("ADMIN con costoFijo negativo → 400 (Zod, sin llegar al servicio)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(asSession("ADMIN"));
    const res = await pagoPATCH(
      makeRequest("/api/matrices/pago/PSE", { costoFijo: "-1" }),
      pagoCtx("PSE"),
    );
    expect(res.status).toBe(400);
    expect(actualizarCostoPago).not.toHaveBeenCalled();
  });

  it("ADMIN con payload válido → 200 y delega en el servicio con BigInt", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(asSession("ADMIN"));
    vi.mocked(actualizarCostoPago).mockResolvedValue({
      id: "1",
      canalPago: "PSE",
      descripcion: "PSE",
      costoFijo: 0n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await pagoPATCH(
      makeRequest("/api/matrices/pago/PSE", { costoFijo: "0" }),
      pagoCtx("PSE"),
    );
    expect(res.status).toBe(200);
    expect(actualizarCostoPago).toHaveBeenCalledWith("PSE", 0n, "user-test-id");
    const body = await res.json();
    expect(body.matrizPago.costoFijo).toBe("0");
  });
});
