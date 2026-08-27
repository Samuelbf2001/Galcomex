/**
 * Tests de integración — Edición de costos bancarios (MatrizRecaudo / MatrizPago)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten (skip).
 *
 * IMPORTANTE: MatrizRecaudo/MatrizPago son datos de referencia compartidos
 * (otros tests leen su costoFijo dinámicamente, ver borradores/service.test.ts
 * y cartera/service.test.ts). Este archivo guarda el costoFijo original de las
 * filas que toca y lo restaura en afterAll para no dejar la BD local
 * modificada entre corridas.
 *
 * TEST_PREFIX único: "vitest-matrices"
 */
import "dotenv/config";

import { CanalPago, Rol, TipoRecaudo } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  CostoFijoNegativoError,
  MatrizPagoNoEncontradaError,
  MatrizRecaudoNoEncontradaError,
  actualizarCostoPago,
  actualizarCostoRecaudo,
} from "../service";

const TEST_PREFIX = "vitest-matrices";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const TIPO_RECAUDO_TEST = TipoRecaudo.CAJERO;
const CANAL_PAGO_TEST = CanalPago.PSE;

type Fixture = { userId: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let costoRecaudoOriginal: bigint | null = null;
let costoPagoOriginal: bigint | null = null;

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
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Matrices",
      rol: Rol.ADMIN,
    },
  });

  return { userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de matrices",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

describe("matrices service — costos bancarios con Postgres local", () => {
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

      const recaudo = await prisma.matrizRecaudo.findUnique({
        where: { tipoRecaudo: TIPO_RECAUDO_TEST },
        select: { costoFijo: true },
      });
      costoRecaudoOriginal = recaudo?.costoFijo ?? null;

      const pago = await prisma.matrizPago.findUnique({
        where: { canalPago: CANAL_PAGO_TEST },
        select: { costoFijo: true },
      });
      costoPagoOriginal = pago?.costoFijo ?? null;
    } catch (error) {
      dbUnavailableReason = `BD local Postgres no disponible: ${unavailableMessage(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) {
      // Restaurar los valores originales de las filas de matriz tocadas —
      // son datos de referencia compartidos con el resto de la suite.
      if (costoRecaudoOriginal !== null) {
        await prisma.matrizRecaudo.update({
          where: { tipoRecaudo: TIPO_RECAUDO_TEST },
          data: { costoFijo: costoRecaudoOriginal },
        });
      }
      if (costoPagoOriginal !== null) {
        await prisma.matrizPago.update({
          where: { canalPago: CANAL_PAGO_TEST },
          data: { costoFijo: costoPagoOriginal },
        });
      }
      await cleanupTestData();
    }
    await prisma.$disconnect();
  });

  it("actualizarCostoRecaudo actualiza costoFijo y crea AuditLog con antes/después", async (ctx) => {
    const db = ensureDb(ctx);
    if (costoRecaudoOriginal === null) {
      ctx.skip(`matriz_recaudo no tiene fila ${TIPO_RECAUDO_TEST}; omitiendo test.`);
      return;
    }

    const nuevoCosto = costoRecaudoOriginal + 1_000n;
    const actualizado = await actualizarCostoRecaudo(
      TIPO_RECAUDO_TEST,
      nuevoCosto,
      db.userId,
    );

    expect(actualizado.costoFijo).toBe(nuevoCosto);

    const enBd = await prisma.matrizRecaudo.findUnique({
      where: { tipoRecaudo: TIPO_RECAUDO_TEST },
    });
    expect(enBd?.costoFijo).toBe(nuevoCosto);

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidad: "MatrizRecaudo", entidadId: enBd!.id, usuarioId: db.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog?.antes).toMatchObject({
      tipoRecaudo: TIPO_RECAUDO_TEST,
      costoFijo: costoRecaudoOriginal.toString(),
    });
    expect(auditLog?.despues).toMatchObject({
      tipoRecaudo: TIPO_RECAUDO_TEST,
      costoFijo: nuevoCosto.toString(),
    });

    // Restaurar de inmediato para no afectar otros tests de la misma corrida.
    await actualizarCostoRecaudo(TIPO_RECAUDO_TEST, costoRecaudoOriginal, db.userId);
  });

  it("actualizarCostoPago actualiza costoFijo y crea AuditLog con antes/después", async (ctx) => {
    const db = ensureDb(ctx);
    if (costoPagoOriginal === null) {
      ctx.skip(`matriz_pago no tiene fila ${CANAL_PAGO_TEST}; omitiendo test.`);
      return;
    }

    const nuevoCosto = costoPagoOriginal + 500n;
    const actualizado = await actualizarCostoPago(
      CANAL_PAGO_TEST,
      nuevoCosto,
      db.userId,
    );

    expect(actualizado.costoFijo).toBe(nuevoCosto);

    const enBd = await prisma.matrizPago.findUnique({
      where: { canalPago: CANAL_PAGO_TEST },
    });
    expect(enBd?.costoFijo).toBe(nuevoCosto);

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidad: "MatrizPago", entidadId: enBd!.id, usuarioId: db.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog?.antes).toMatchObject({
      canalPago: CANAL_PAGO_TEST,
      costoFijo: costoPagoOriginal.toString(),
    });
    expect(auditLog?.despues).toMatchObject({
      canalPago: CANAL_PAGO_TEST,
      costoFijo: nuevoCosto.toString(),
    });

    // Restaurar de inmediato para no afectar otros tests de la misma corrida.
    await actualizarCostoPago(CANAL_PAGO_TEST, costoPagoOriginal, db.userId);
  });

  it("rechaza costoFijo negativo con CostoFijoNegativoError (recaudo y pago)", async (ctx) => {
    const db = ensureDb(ctx);

    await expect(
      actualizarCostoRecaudo(TIPO_RECAUDO_TEST, -1n, db.userId),
    ).rejects.toBeInstanceOf(CostoFijoNegativoError);

    await expect(
      actualizarCostoPago(CANAL_PAGO_TEST, -1n, db.userId),
    ).rejects.toBeInstanceOf(CostoFijoNegativoError);
  });

  it("actualizarCostoRecaudo rechaza tipoRecaudo sin fila en la matriz", async (ctx) => {
    const db = ensureDb(ctx);

    // TipoRecaudo es un enum de Prisma; todos sus valores tienen fila en la
    // matriz sembrada. Para probar el path de "no encontrado" borramos
    // temporalmente una fila distinta a TIPO_RECAUDO_TEST y la restauramos.
    const tipoBorrado = TipoRecaudo.SUCURSAL;
    const original = await prisma.matrizRecaudo.findUnique({
      where: { tipoRecaudo: tipoBorrado },
    });
    if (!original) {
      ctx.skip(`Fila ${tipoBorrado} no encontrada en matriz_recaudo — seed faltante`);
      return;
    }

    await prisma.matrizRecaudo.delete({ where: { tipoRecaudo: tipoBorrado } });
    try {
      await expect(
        actualizarCostoRecaudo(tipoBorrado, 1_000n, db.userId),
      ).rejects.toBeInstanceOf(MatrizRecaudoNoEncontradaError);
    } finally {
      await prisma.matrizRecaudo.create({
        data: {
          id: original.id,
          tipoRecaudo: original.tipoRecaudo,
          grupo: original.grupo,
          descripcion: original.descripcion,
          costoFijo: original.costoFijo,
        },
      });
    }
  });

  it("actualizarCostoPago rechaza canalPago sin fila en la matriz", async (ctx) => {
    const db = ensureDb(ctx);

    const canalBorrado = CanalPago.TRANSF_OTROS_BANCOS;
    const original = await prisma.matrizPago.findUnique({
      where: { canalPago: canalBorrado },
    });
    if (!original) {
      ctx.skip(`Fila ${canalBorrado} no encontrada en matriz_pago — seed faltante`);
      return;
    }

    await prisma.matrizPago.delete({ where: { canalPago: canalBorrado } });
    try {
      await expect(
        actualizarCostoPago(canalBorrado, 1_000n, db.userId),
      ).rejects.toBeInstanceOf(MatrizPagoNoEncontradaError);
    } finally {
      await prisma.matrizPago.create({
        data: {
          id: original.id,
          canalPago: original.canalPago,
          descripcion: original.descripcion,
          costoFijo: original.costoFijo,
        },
      });
    }
  });
});
