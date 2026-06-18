import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  Rol,
  TipoCliente,
  TipoRecaudo,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  crearAnticipoSchema,
} from "@/lib/validations/anticipos";
import {
  aplicarAnticipo,
  crearAnticipo,
  eliminarAplicacion,
  getAnticipoConSaldo,
  listarAnticipos,
} from "../service";

const TEST_PREFIX = "vitest-anticipos";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3001;

type Fixture = {
  clienteId: string;
  userId: string;
  tramiteIds: string[];
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

  const userIds = testUsers.map((u) => u.id);
  const clienteIds = testClients.map((c) => c.id);

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
  const tramiteIds = testTramites.map((t) => t.id);

  // Limpiar aplicaciones y anticipos primero (FK sobre tramite y anticipo)
  const testAnticipos = await prisma.anticipo.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const anticipoIds = testAnticipos.map((a) => a.id);

  await prisma.aplicacionAnticipo.deleteMany({
    where: {
      OR: [
        { anticipoId: { in: anticipoIds } },
        { tramiteId: { in: tramiteIds } },
      ],
    },
  });
  await prisma.anticipo.deleteMany({
    where: { id: { in: anticipoIds } },
  });
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
  await prisma.cliente.deleteMany({
    where: { id: { in: clienteIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Anticipos",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Anticipos",
      nit: `${TEST_PREFIX}-nit-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  // Crear 4 tramites de prueba
  const tramiteIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const tramite = await prisma.tramiteDO.create({
      data: {
        consecutivo: `DO.BAQ${String(stateYear).slice(-2)}-${String(i).padStart(4, "0")}-${runId}`,
        ciudad: Ciudad.BAQ,
        anio: stateYear,
        numero: i * 1000 + Math.floor(Math.random() * 999),
        clienteId: cliente.id,
        agenciaAduanas: AgenciaAduanas.COLDEX,
        creadoPorId: user.id,
        comentarios: `${TEST_PREFIX}:${runId}:tramite${i}`,
      },
    });
    tramiteIds.push(tramite.id);
  }

  return { clienteId: cliente.id, userId: user.id, tramiteIds };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de anticipos",
    );
    throw new Error("Test omitido porque la BD local no esta disponible");
  }

  return fixture;
}

describe("anticipos service con Postgres local", () => {
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

  it("crea un anticipo y lo recupera con saldo correcto", async (ctx) => {
    const db = ensureDb(ctx);

    const anticipo = await crearAnticipo({
      clienteId: db.clienteId,
      monto: 10_000_000n,
      fecha: new Date("3001-01-15"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
    });

    expect(anticipo.monto).toBe(10_000_000n);
    expect(anticipo.clienteId).toBe(db.clienteId);

    const conSaldo = await getAnticipoConSaldo(anticipo.id);
    expect(conSaldo).not.toBeNull();
    expect(conSaldo!.aplicado).toBe(0n);
    expect(conSaldo!.restante).toBe(10_000_000n);
    expect(conSaldo!.aplicaciones).toHaveLength(0);
  });

  it("anticipo 34.369.000 aplicado a 3 DOs; 4o excede restante → 422", async (ctx) => {
    const db = ensureDb(ctx);

    const anticipo = await crearAnticipo({
      clienteId: db.clienteId,
      monto: 34_369_000n,
      fecha: new Date("3001-02-01"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
    });

    // Aplicar al primer DO: 10.000.000
    const r1 = await aplicarAnticipo({
      anticipoId: anticipo.id,
      tramiteId: db.tramiteIds[0],
      montoAplicado: 10_000_000n,
    });
    expect(r1.ok).toBe(true);

    // Aplicar al segundo DO: 15.000.000
    const r2 = await aplicarAnticipo({
      anticipoId: anticipo.id,
      tramiteId: db.tramiteIds[1],
      montoAplicado: 15_000_000n,
    });
    expect(r2.ok).toBe(true);

    // Aplicar al tercer DO: 9.000.000 → total aplicado = 34.000.000, restante = 369.000
    const r3 = await aplicarAnticipo({
      anticipoId: anticipo.id,
      tramiteId: db.tramiteIds[2],
      montoAplicado: 9_000_000n,
    });
    expect(r3.ok).toBe(true);

    const conSaldo = await getAnticipoConSaldo(anticipo.id);
    expect(conSaldo!.aplicado).toBe(34_000_000n);
    expect(conSaldo!.restante).toBe(369_000n);
    expect(conSaldo!.aplicaciones).toHaveLength(3);

    // Intentar aplicar al cuarto DO: 500.000 → excede restante (369.000) → debe fallar 422
    const r4 = await aplicarAnticipo({
      anticipoId: anticipo.id,
      tramiteId: db.tramiteIds[3],
      montoAplicado: 500_000n,
    });
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.status).toBe(422);
      expect(r4.message).toMatch(/restante/i);
    }

    // Verificar que el saldo no cambio
    const conSaldoDespues = await getAnticipoConSaldo(anticipo.id);
    expect(conSaldoDespues!.aplicado).toBe(34_000_000n);
    expect(conSaldoDespues!.restante).toBe(369_000n);
    expect(conSaldoDespues!.aplicaciones).toHaveLength(3);
  });

  it("listarAnticipos con conSaldo=true retorna solo los que tienen restante > 0", async (ctx) => {
    const db = ensureDb(ctx);

    // Anticipo totalmente aplicado
    const anticipoAgotado = await crearAnticipo({
      clienteId: db.clienteId,
      monto: 5_000_000n,
      fecha: new Date("3001-03-01"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
    });
    // Aplicar el monto completo
    await aplicarAnticipo({
      anticipoId: anticipoAgotado.id,
      tramiteId: db.tramiteIds[0],
      montoAplicado: 5_000_000n,
    });

    // Anticipo con saldo disponible
    const anticipoConSaldo = await crearAnticipo({
      clienteId: db.clienteId,
      monto: 8_000_000n,
      fecha: new Date("3001-03-05"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
    });
    await aplicarAnticipo({
      anticipoId: anticipoConSaldo.id,
      tramiteId: db.tramiteIds[1],
      montoAplicado: 3_000_000n,
    });

    const todos = await listarAnticipos({ clienteId: db.clienteId });
    const conSaldoFiltrado = await listarAnticipos({
      clienteId: db.clienteId,
      conSaldo: true,
    });

    // Todos los anticipos del cliente deben aparecer en "todos"
    expect(todos.length).toBeGreaterThanOrEqual(2);

    // Solo los que tienen restante > 0 en el filtrado
    expect(conSaldoFiltrado.every((a) => a.restante > 0n)).toBe(true);

    // El anticipoAgotado no debe aparecer en conSaldo
    const agotadoEnFiltrado = conSaldoFiltrado.find(
      (a) => a.id === anticipoAgotado.id,
    );
    expect(agotadoEnFiltrado).toBeUndefined();

    // El anticipoConSaldo SI debe aparecer
    const conSaldoEnFiltrado = conSaldoFiltrado.find(
      (a) => a.id === anticipoConSaldo.id,
    );
    expect(conSaldoEnFiltrado).toBeDefined();
    expect(conSaldoEnFiltrado!.restante).toBe(5_000_000n);
    expect(conSaldoEnFiltrado!.aplicado).toBe(3_000_000n);

    // Verificar desglose por DO
    expect(conSaldoEnFiltrado!.aplicaciones).toHaveLength(1);
    expect(conSaldoEnFiltrado!.aplicaciones[0].tramiteId).toBe(
      db.tramiteIds[1],
    );
  });

  it("eliminar una aplicacion recalcula el restante correctamente (test de reversa)", async (ctx) => {
    const db = ensureDb(ctx);

    const anticipo = await crearAnticipo({
      clienteId: db.clienteId,
      monto: 20_000_000n,
      fecha: new Date("3001-04-01"),
      tipoRecaudo: TipoRecaudo.OTROS_BANCOS,
    });

    // Aplicar 12.000.000
    const r1 = await aplicarAnticipo({
      anticipoId: anticipo.id,
      tramiteId: db.tramiteIds[0],
      montoAplicado: 12_000_000n,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("Aplicacion fallida");

    const saldoDespuesAplicar = await getAnticipoConSaldo(anticipo.id);
    expect(saldoDespuesAplicar!.aplicado).toBe(12_000_000n);
    expect(saldoDespuesAplicar!.restante).toBe(8_000_000n);

    // Eliminar la aplicacion
    await eliminarAplicacion(r1.aplicacion.id);

    // El restante debe volver a 20.000.000
    const saldoDespuesEliminar = await getAnticipoConSaldo(anticipo.id);
    expect(saldoDespuesEliminar!.aplicado).toBe(0n);
    expect(saldoDespuesEliminar!.restante).toBe(20_000_000n);
    expect(saldoDespuesEliminar!.aplicaciones).toHaveLength(0);
  });

  it("monto negativo es rechazado por el schema de validacion", () => {
    const result = crearAnticipoSchema.safeParse({
      clienteId: "some-id",
      monto: -1000,
      fecha: "3001-01-01",
      tipoRecaudo: "BANCOLOMBIA",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const montoError = result.error.issues.find(
        (i) => i.path[0] === "monto",
      );
      expect(montoError).toBeDefined();
    }
  });

  it("monto cero es rechazado por el schema de validacion", () => {
    const result = crearAnticipoSchema.safeParse({
      clienteId: "some-id",
      monto: 0,
      fecha: "3001-01-01",
      tipoRecaudo: "BANCOLOMBIA",
    });
    expect(result.success).toBe(false);
  });
});
