import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  EstadoTramite,
  Rol,
  TipoCliente,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  createTramite,
  formatConsecutivo,
  transitionTramite,
} from "../service";

const TEST_PREFIX = "vitest-tramites";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const templatePrefix = "000 Vitest Tramites";
const stateYear = 2098;
const concurrencyYear = 2099;

type Fixture = {
  clienteId: string;
  userId: string;
};

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
  const testClients = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });

  const userIds = testUsers.map((user) => user.id);
  const clienteIds = testClients.map((cliente) => cliente.id);

  const testTramites = await prisma.tramiteDO.findMany({
    where: {
      OR: [
        { creadoPorId: { in: userIds } },
        { clienteId: { in: clienteIds } },
        { comentarios: { startsWith: TEST_PREFIX } },
      ],
    },
    select: { id: true },
  });
  const tramiteIds = testTramites.map((tramite) => tramite.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
      ],
    },
  });
  await prisma.estadoLog.deleteMany({
    where: {
      OR: [{ usuarioId: { in: userIds } }, { tramiteId: { in: tramiteIds } }],
    },
  });
  await prisma.checklistItem.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.tramiteDO.deleteMany({
    where: { id: { in: tramiteIds } },
  });
  await prisma.plantillaChecklistItem.deleteMany({
    where: {
      plantilla: {
        nombre: { startsWith: templatePrefix },
      },
    },
  });
  await prisma.plantillaChecklist.deleteMany({
    where: { nombre: { startsWith: templatePrefix } },
  });
  await prisma.cliente.deleteMany({
    where: { id: { in: clienteIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
}

async function createFixture(): Promise<Fixture> {
  await prisma.plantillaChecklist.create({
    data: {
      nombre: `${templatePrefix} ${runId}`,
      items: {
        create: [
          { descripcion: "Factura comercial", requerido: true, orden: 1 },
          { descripcion: "BL", requerido: true, orden: 2 },
          { descripcion: "Packing list", requerido: false, orden: 3 },
        ],
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Tramites",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Tramites",
      nit: `${runId}-nit`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de tramites",
    );
    throw new Error("Test omitido porque la BD local no esta disponible");
  }

  return fixture;
}

function createInput(overrides: Partial<Parameters<typeof createTramite>[0]> = {}) {
  if (!fixture) {
    throw new Error("Fixture de BD no inicializado");
  }

  return {
    ciudad: Ciudad.BAQ,
    anio: stateYear,
    clienteId: fixture.clienteId,
    agenciaAduanas: AgenciaAduanas.COLDEX,
    creadoPorId: fixture.userId,
    comentarios: `${TEST_PREFIX}:${runId}`,
    ...overrides,
  };
}

describe("formatConsecutivo", () => {
  it("formatea ciudad, ultimos dos digitos del anio y numero con cuatro digitos", () => {
    expect(formatConsecutivo(Ciudad.CTG, 2026, 1)).toBe("DO.CTG26-0001");
    expect(formatConsecutivo(Ciudad.BUN, 2026, 26)).toBe("DO.BUN26-0026");
    expect(formatConsecutivo(Ciudad.SMR, 2099, 1234)).toBe(
      "DO.SMR99-1234",
    );
  });
});

describe("tramites service con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason =
        "DATABASE_URL no esta definida; se omiten tests de integracion con Postgres";
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

  it("rechaza una transicion invalida", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await createTramite(
      createInput({
        ciudad: Ciudad.BAQ,
        anio: stateYear,
        creadoPorId: db.userId,
      }),
    );

    const result = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      db.userId,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: "Transicion invalida: SOLICITUD -> EN_TRAMITE",
    });

    const persisted = await prisma.tramiteDO.findUnique({
      where: { id: tramite.id },
      select: { estado: true },
    });
    expect(persisted?.estado).toBe(EstadoTramite.SOLICITUD);
  });

  it("bloquea APERTURA -> EN_TRAMITE cuando falta checklist requerido", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await createTramite(
      createInput({
        ciudad: Ciudad.CTG,
        anio: stateYear,
        creadoPorId: db.userId,
      }),
    );

    await prisma.tramiteDO.update({
      where: { id: tramite.id },
      data: { estado: EstadoTramite.APERTURA },
    });

    const result = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      db.userId,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: "Checklist requerido incompleto",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      expect.fail("La transicion debio ser rechazada");
    }
    expect(result.faltantes?.slice().sort()).toEqual([
      "BL",
      "Factura comercial",
    ]);

    const persisted = await prisma.tramiteDO.findUnique({
      where: { id: tramite.id },
      select: { estado: true },
    });
    expect(persisted?.estado).toBe(EstadoTramite.APERTURA);
  });

  it("crea 20 tramites concurrentes sin consecutivos duplicados ni saltos", async (ctx) => {
    const db = ensureDb(ctx);
    const ciudad = Ciudad.SMR;
    const cantidad = 20;

    const tramites = await Promise.all(
      Array.from({ length: cantidad }, (_, index) =>
        createTramite(
          createInput({
            ciudad,
            anio: concurrencyYear,
            creadoPorId: db.userId,
            comentarios: `${TEST_PREFIX}:${runId}:concurrency:${index}`,
          }),
        ),
      ),
    );

    const ordered = [...tramites].sort((a, b) => a.numero - b.numero);
    const numeros = ordered.map((tramite) => tramite.numero);
    const expectedNumeros = Array.from(
      { length: cantidad },
      (_, index) => numeros[0] + index,
    );

    expect(new Set(numeros)).toHaveLength(cantidad);
    expect(numeros).toEqual(expectedNumeros);
    expect(new Set(ordered.map((tramite) => tramite.consecutivo))).toHaveLength(
      cantidad,
    );
    expect(ordered.map((tramite) => tramite.consecutivo)).toEqual(
      ordered.map((tramite) =>
        formatConsecutivo(ciudad, concurrencyYear, tramite.numero),
      ),
    );
  });
});
