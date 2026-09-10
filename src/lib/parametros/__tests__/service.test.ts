/**
 * Tests de integración — Edición de Parametro genéricos (Configuración editable)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-parametros"
 */
import "dotenv/config";

import { Rol } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  ParametroNoEncontradoError,
  ParametroSiigoProtegidoError,
  actualizarParametro,
} from "../service";

const TEST_PREFIX = "vitest-parametros";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const claveTest = `VITEST_PARAM_${Date.now()}`;

type Fixture = { userId: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupTestData() {
  const testUsers = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const userIds = testUsers.map((u) => u.id);

  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: userIds } } });
  await prisma.parametro.deleteMany({ where: { clave: claveTest } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Parametros",
      rol: Rol.ADMIN,
    },
  });

  await prisma.parametro.create({
    data: {
      clave: claveTest,
      valor: "valor-inicial",
      descripcion: "Parámetro de prueba vitest",
    },
  });

  return { userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de parametros",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

describe("parametros service — actualizarParametro con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason =
        "DATABASE_URL no está definida; se omiten tests de integración con Postgres";
      return;
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      fixture = await createFixture();
    } catch (error) {
      dbUnavailableReason = `BD local Postgres no disponible: ${unavailableMessage(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) {
      await cleanupTestData();
    }
    await prisma.$disconnect();
  });

  it("actualiza el valor y crea AuditLog con antes/después en la misma transacción", async (ctx) => {
    const db = ensureDb(ctx);

    const actualizado = await actualizarParametro(
      claveTest,
      "valor-nuevo",
      db.userId,
    );

    expect(actualizado.valor).toBe("valor-nuevo");

    const enBd = await prisma.parametro.findUnique({ where: { clave: claveTest } });
    expect(enBd?.valor).toBe("valor-nuevo");

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidad: "Parametro", entidadId: enBd!.id, usuarioId: db.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog?.antes).toMatchObject({ clave: claveTest, valor: "valor-inicial" });
    expect(auditLog?.despues).toMatchObject({ clave: claveTest, valor: "valor-nuevo" });
  });

  it("rechaza claves inexistentes con ParametroNoEncontradoError", async (ctx) => {
    const db = ensureDb(ctx);

    await expect(
      actualizarParametro("CLAVE_QUE_NO_EXISTE_VITEST", "x", db.userId),
    ).rejects.toBeInstanceOf(ParametroNoEncontradoError);
  });

  it("rechaza claves SIIGO_* con ParametroSiigoProtegidoError (protegidas por su propio flujo)", async (ctx) => {
    const db = ensureDb(ctx);

    await expect(
      actualizarParametro("SIIGO_VENDEDOR_ID", "999", db.userId),
    ).rejects.toBeInstanceOf(ParametroSiigoProtegidoError);
  });
});
