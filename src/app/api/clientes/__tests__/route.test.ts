/**
 * A1-T2 — API de clientes y tarifario (integración con BD)
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no está.
 * Rol ADMIN mockeado para todos los tests de mutación.
 * Usa TEST_PREFIX "vitest-clientes-api" en NIT para cleanup seguro.
 */

import "dotenv/config";

import { TipoCliente } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

// ── Mocks de autenticación ─────────────────────────────────────────────────────

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

// ── Importaciones post-mock ────────────────────────────────────────────────────

import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { GET as clientesGET, POST as clientesPOST } from "@/app/api/clientes/route";
import { GET as clienteByIdGET } from "@/app/api/clientes/[id]/route";

// ── Setup: sesión ADMIN siempre activa ────────────────────────────────────────

const ADMIN_SESSION = {
  user: {
    id: "admin-test-user",
    rol: "ADMIN" as Rol,
    email: "admin@test.galcomex",
    name: "Admin Test",
    emailVerified: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
  session: {
    id: "admin-session-id",
    userId: "admin-test-user",
    expiresAt: new Date(Date.now() + 86_400_000),
    token: "admin-token",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ipAddress: null as string | null | undefined,
    userAgent: null as string | null | undefined,
  },
};

// ── Constantes ────────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-clientes-api";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── Estado BD ─────────────────────────────────────────────────────────────────

let dbConnected = false;
let dbUnavailableReason: string | null = null;
const createdClienteIds: string[] = [];

// ── Helpers ────────────────────────────────────────────────────────────────────

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD no disponible");
  }
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

function nit(suffix: string) {
  return `${RUN_ID}-${suffix}`;
}

async function postCliente(body: unknown): Promise<Response> {
  return clientesPOST(
    makeRequest("/api/clientes", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Siempre usar sesión ADMIN
  vi.mocked(auth.api.getSession).mockResolvedValue(ADMIN_SESSION);

  if (!process.env.DATABASE_URL) {
    dbUnavailableReason =
      "DATABASE_URL no definida; se omiten tests de integración de clientes";
    return;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${unavailableMessage(error)}`;
  }
});

afterAll(async () => {
  if (!dbConnected) return;

  // Limpieza en orden de dependencias (FK: tarifas→clientes)
  if (createdClienteIds.length > 0) {
    await prisma.tarifaCliente.deleteMany({
      where: { clienteId: { in: createdClienteIds } },
    });
    await prisma.cliente.deleteMany({
      where: { id: { in: createdClienteIds } },
    });
  }

  // Limpieza extra por NIT prefix (por si algún test insertó sin registrar ID)
  const extraClientes = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  if (extraClientes.length > 0) {
    const ids = extraClientes.map((c) => c.id);
    await prisma.tarifaCliente.deleteMany({ where: { clienteId: { in: ids } } });
    await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("A1-T2 — API /api/clientes (integración BD)", () => {
  // ── POST con payload inválido → 400 ─────────────────────────────────────────

  describe("POST — validación Zod", () => {
    it("NIT vacío → 400 con mensaje claro", async (ctx) => {
      ensureDb(ctx);

      const res = await postCliente({ nombre: "Cliente Válido", nit: "" });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; details: { campo: string; mensaje: string }[] };
      expect(body.error).toBe("Payload invalido");
      const nitIssue = body.details.find((d) => d.campo === "nit");
      expect(nitIssue).toBeDefined();
      expect(nitIssue?.mensaje).toMatch(/obligatorio/i);
    });

    it("tarifa con valor negativo → 400 con mensaje claro en details", async (ctx) => {
      ensureDb(ctx);

      const res = await postCliente({
        nombre: "Cliente Válido",
        nit: nit("neg-tarifa"),
        tarifas: [
          { anio: 2026, tipo: "fijo", valor: -1 },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; details: { campo: string; mensaje: string }[] };
      expect(body.error).toBe("Payload invalido");
      // Debe haber al menos un issue con el mensaje de tarifa negativa
      const tarifaIssue = body.details.find((d) =>
        d.mensaje.toLowerCase().includes("negativa") ||
        d.campo.includes("valor"),
      );
      expect(tarifaIssue).toBeDefined();
    });

    it("nombre vacío → 400", async (ctx) => {
      ensureDb(ctx);

      const res = await postCliente({ nombre: "", nit: nit("nombre-vacio") });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; details: unknown[] };
      expect(body.error).toBe("Payload invalido");
    });
  });

  // ── POST válido + GET /[id] con tarifas ──────────────────────────────────────

  describe("POST válido + GET /[id] — crea con tarifa 2026 y la retorna", () => {
    it("crea cliente con tarifa 2026 y GET /[id] lo retorna con la tarifa correcta", async (ctx) => {
      ensureDb(ctx);

      const nitValue = nit("crea-con-tarifa");
      const payload = {
        nombre: "Cliente Test Tarifa 2026",
        nit: nitValue,
        tipo: TipoCliente.PROPIO,
        tarifas: [
          { anio: 2026, tipo: "fijo", valor: 150000 },
        ],
      };

      // POST
      const postRes = await postCliente(payload);
      expect(postRes.status).toBe(201);
      const postBody = await postRes.json() as { cliente: { id: string; nit: string; tarifas: { anio: number; valor: string }[] } };
      expect(postBody.cliente.nit).toBe(nitValue);
      expect(postBody.cliente.tarifas).toHaveLength(1);
      expect(postBody.cliente.tarifas[0].anio).toBe(2026);
      // BigInt se serializa como string
      expect(postBody.cliente.tarifas[0].valor).toBe("150000");

      const clienteId = postBody.cliente.id;
      createdClienteIds.push(clienteId);

      // GET /[id]
      const getRes = await clienteByIdGET(
        makeRequest(`/api/clientes/${clienteId}`),
        routeCtx(clienteId),
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { cliente: { id: string; tarifas: { anio: number; valor: string }[] } };
      expect(getBody.cliente.id).toBe(clienteId);

      const tarifa2026 = getBody.cliente.tarifas.find((t) => t.anio === 2026);
      expect(tarifa2026).toBeDefined();
      expect(tarifa2026?.valor).toBe("150000");
    });
  });

  // ── GET ?tipo=socio_lm filtra correctamente ──────────────────────────────────

  describe("GET /api/clientes?tipo=socio_lm — solo retorna SOCIO_LM", () => {
    it("filtra correctamente: retorna SOCIO_LM y no incluye PROPIO", async (ctx) => {
      ensureDb(ctx);

      // Sembrar un cliente PROPIO y uno SOCIO_LM con TEST_PREFIX en NIT
      const nitPropio = nit("tipo-propio");
      const nitSocio = nit("tipo-socio-lm");

      const [propio, socio] = await Promise.all([
        prisma.cliente.create({
          data: { nombre: "Propio Vitest", nit: nitPropio, tipo: TipoCliente.PROPIO },
        }),
        prisma.cliente.create({
          data: { nombre: "Socio LM Vitest", nit: nitSocio, tipo: TipoCliente.SOCIO_LM },
        }),
      ]);
      createdClienteIds.push(propio.id, socio.id);

      // GET ?tipo=socio_lm
      const res = await clientesGET(
        makeRequest("/api/clientes?tipo=socio_lm"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { clientes: { id: string; tipo: string }[] };

      const ids = body.clientes.map((c) => c.id);
      expect(ids).toContain(socio.id);
      expect(ids).not.toContain(propio.id);

      // Todos los retornados son SOCIO_LM
      for (const c of body.clientes) {
        expect(c.tipo).toBe(TipoCliente.SOCIO_LM);
      }
    });
  });

  // ── POST con NIT duplicado → 409 ─────────────────────────────────────────────

  describe("POST — NIT duplicado → 409", () => {
    it("segundo POST con el mismo NIT devuelve 409", async (ctx) => {
      ensureDb(ctx);

      const nitValue = nit("dup-nit");
      const payload = { nombre: "Cliente Dup 1", nit: nitValue };

      // Primer POST — debe ser 201
      const res1 = await postCliente(payload);
      expect(res1.status).toBe(201);
      const body1 = await res1.json() as { cliente: { id: string } };
      createdClienteIds.push(body1.cliente.id);

      // Segundo POST con el mismo NIT — debe ser 409
      const res2 = await postCliente({ nombre: "Cliente Dup 2", nit: nitValue });
      expect(res2.status).toBe(409);
      const body2 = await res2.json() as { error: string };
      expect(body2.error).toMatch(/ya existe/i);
    });
  });
});
