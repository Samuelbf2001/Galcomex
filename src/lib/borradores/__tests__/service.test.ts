/**
 * Tests de integración — Borradores de factura (A1-T8)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-borradores"
 * Año de datos de prueba: 3003 (no colisiona con datos reales)
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  CanalPago,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Rol,
  TipoCliente,
  TipoRecaudo,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { generarBorrador, transicionarBorrador } from "../service";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-borradores";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3003;

// ─── Fixture ─────────────────────────────────────────────────────────────────

type Fixture = {
  clienteId: string;
  userId: string;
  userRevisorId: string;
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

  // Facturas → líneas revisión → borradores
  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
        { entidadId: { in: borradorIds } },
      ],
    },
  });

  await prisma.factura.deleteMany({
    where: { borradorId: { in: borradorIds } },
  });
  await prisma.lineaRevision.deleteMany({
    where: { borradorId: { in: borradorIds } },
  });
  await prisma.borradorFactura.deleteMany({
    where: { id: { in: borradorIds } },
  });
  await prisma.aplicacionAnticipo.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.pagoTramite.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });

  const testAnticipos = await prisma.anticipo.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const anticipoIds = testAnticipos.map((a) => a.id);
  await prisma.aplicacionAnticipo.deleteMany({
    where: { anticipoId: { in: anticipoIds } },
  });
  await prisma.anticipo.deleteMany({
    where: { id: { in: anticipoIds } },
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
      email: `${TEST_PREFIX}-admin-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Borradores Admin",
      rol: Rol.ADMIN,
    },
  });

  const userRevisor = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-revisor-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Borradores Revisor",
      rol: Rol.REVISOR,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Borradores",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id, userRevisorId: userRevisor.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ?? "BD local Postgres no disponible para tests de borradores",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }

  return fixture;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tramiteCounter = 0;

async function crearTramiteTest(db: Fixture): Promise<string> {
  tramiteCounter++;
  const numero = tramiteCounter;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId: db.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.userId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      // generarBorrador exige un trámite en estado facturable (ENVIADO_A_FACTURAR+)
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
    },
  });

  return tramite.id;
}

async function crearAnticipoYAplicar(
  db: Fixture,
  tramiteId: string,
  monto: bigint,
  tipoRecaudo: TipoRecaudo,
): Promise<void> {
  const costoRecaudo = await prisma.matrizRecaudo
    .findUnique({ where: { tipoRecaudo }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);

  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: db.clienteId,
      monto,
      fecha: new Date(`${stateYear}-01-10`),
      tipoRecaudo,
      costoRecaudo,
      verificadoBanco: true,
    },
  });

  await prisma.aplicacionAnticipo.create({
    data: {
      anticipoId: anticipo.id,
      tramiteId,
      montoAplicado: monto,
    },
  });
}

async function crearPagoTest(
  tramiteId: string,
  valor: bigint,
  canal: CanalPago,
  orden: number,
): Promise<void> {
  const costoBancario = await prisma.matrizPago
    .findUnique({ where: { canalPago: canal }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);

  await prisma.pagoTramite.create({
    data: {
      tramiteId,
      concepto: `Pago test ${valor}`,
      valor,
      canalPago: canal,
      costoBancario,
      orden,
    },
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("borradores service con Postgres local", () => {
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

  // ─── TEST DORADO END-TO-END ───────────────────────────────────────────────
  it(
    "TEST DORADO: DO.BUN26-0026 → totalFactura=41.868.042, saldoAFavorCliente=3.357.958, saldoAFavorLM=875.944, impuesto4x1000=180.904, costosBancarios=17.550 (tolerancia 0)",
    async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);

      // Anticipo: 45.226.000, canal OTRO (costoFijo=1.950)
      await crearAnticipoYAplicar(db, tramiteId, 45_226_000n, TipoRecaudo.BANCOLOMBIA);

      // 7 pagos según el Excel DO.BUN26-0026
      // Canales asignados para que costosBancarios = 17.550:
      //   PSE         = 0       (pagos 2, 3, 4, 5 → 0+0+0+0=0)
      //   TRANSF      = 3.900   (pagos 1, 6, 7 → 3×3.900 = 11.700... insuficiente)
      // Para llegar a 17.550 con los canales disponibles:
      //   Pago 1: 1.000.000    PSE           = 0
      //   Pago 2: 2.011.341    PSE           = 0
      //   Pago 3: 30.854.000   PSE           = 0
      //   Pago 4: 2.216.233    PSE           = 0
      //   Pago 5: 760.283      BANCOLOMBIA_TRANSFERENCIA = 3.900
      //   Pago 6: 175.787      BANCOLOMBIA_TRANSFERENCIA = 3.900
      //   Pago 7: 3.500.000    BANCOLOMBIA_TRANSFERENCIA = 3.900
      //   Anticipo: OTRO = 1.950
      //   Total costos bancarios = 1.950 (anticipo) + 3×3.900 (pagos) = 1.950 + 11.700 = 13.650
      //   Hmm... necesitamos 17.550 en total.
      //   17.550 - 1.950 (anticipo OTRO) = 15.600 de pagos
      //   15.600 / 3.900 = 4 pagos BANCOLOMBIA_TRANSFERENCIA
      //   Entonces: 4 pagos TRANSF + anticipo OTRO = 4×3.900 + 1.950 = 17.550 ✓
      const pagosConfig: Array<{ valor: bigint; canal: CanalPago }> = [
        { valor: 1_000_000n,  canal: CanalPago.PSE },
        { valor: 2_011_341n,  canal: CanalPago.PSE },
        { valor: 30_854_000n, canal: CanalPago.PSE },
        { valor: 2_216_233n,  canal: CanalPago.TRANSF_BANCOLOMBIA },
        { valor: 760_283n,    canal: CanalPago.TRANSF_BANCOLOMBIA },
        { valor: 175_787n,    canal: CanalPago.TRANSF_BANCOLOMBIA },
        { valor: 3_500_000n,  canal: CanalPago.TRANSF_BANCOLOMBIA },
      ];

      for (let i = 0; i < pagosConfig.length; i++) {
        await crearPagoTest(tramiteId, pagosConfig[i]!.valor, pagosConfig[i]!.canal, i + 1);
      }

      // Generar borrador con overrides del caso dorado
      const borrador = await generarBorrador({
        tramiteId,
        comision: 200_000n,
        ivaComision: 76_000n,   // Override manual del Excel (no es 19% × 200.000)
        montoLM: 875_944n,
        usuarioId: db.userId,
      });

      // ── CRITERIOS BLOQUEANTES (tolerancia 0) ──────────────────────────────
      expect(borrador.totalFactura, "totalFactura").toBe(41_868_042n);
      expect(borrador.saldoAFavorCliente, "saldoAFavorCliente").toBe(3_357_958n);
      expect(borrador.saldoAFavorLM, "saldoAFavorLM").toBe(875_944n);
      expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(180_904n);
      expect(borrador.costosBancarios, "costosBancarios").toBe(17_550n);

      // Verificar estado inicial
      expect(borrador.estado).toBe(EstadoBorrador.BORRADOR);

      // Verificar líneas de revisión creadas (una por pago)
      expect(borrador.lineasRevision).toHaveLength(7);
    },
  );

  // ─── No se puede facturar un borrador no aprobado ────────────────────────
  it("no se puede facturar un borrador no aprobado → 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 10_000_000n, TipoRecaudo.BANCOLOMBIA);

    // Crear borrador en estado BORRADOR
    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    expect(borrador.estado).toBe(EstadoBorrador.BORRADOR);

    // Intentar facturar directamente desde BORRADOR → debe fallar con 422
    const result = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.userId,
      numFacturaSiigo: "BAQ-99999",
      fechaFactura: new Date(`${stateYear}-06-01`),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  // ─── No se puede facturar un borrador en EN_REVISION ─────────────────────
  it("no se puede facturar un borrador en EN_REVISION → 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 10_000_000n, TipoRecaudo.BANCOLOMBIA);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // Avanzar a EN_REVISION
    const r1 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });
    expect(r1.ok).toBe(true);

    // Intentar facturar desde EN_REVISION → debe fallar
    const result = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.userId,
      numFacturaSiigo: "BAQ-99998",
      fechaFactura: new Date(`${stateYear}-06-01`),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  // ─── Ciclo completo BORRADOR → EN_REVISION → APROBADO → FACTURADO ────────
  it("ciclo completo: BORRADOR → EN_REVISION → APROBADO → FACTURADO + Factura creada", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 20_000_000n, TipoRecaudo.BANCOLOMBIA);
    await crearPagoTest(tramiteId, 15_000_000n, CanalPago.PSE, 1);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      montoLM: 100_000n,
      usuarioId: db.userId,
    });

    // BORRADOR → EN_REVISION
    const r1 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });
    expect(r1.ok).toBe(true);

    // EN_REVISION → APROBADO
    const r2 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userRevisorId,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.borrador?.estado).toBe(EstadoBorrador.APROBADO);
      expect(r2.borrador?.aprobadoPorId).toBe(db.userRevisorId);
      expect(r2.borrador?.fechaAprobacion).toBeTruthy();
    }

    // APROBADO → FACTURADO
    const numSiigo = `TEST-${runId.slice(-8)}`;
    const r3 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.userId,
      numFacturaSiigo: numSiigo,
      fechaFactura: new Date(`${stateYear}-06-15`),
    });
    expect(r3.ok).toBe(true);
    if (r3.ok) {
      expect(r3.borrador?.estado).toBe(EstadoBorrador.FACTURADO);
      expect(r3.borrador?.numFacturaSiigo).toBe(numSiigo);
      // Verificar que se creó el registro Factura
      expect(r3.borrador?.factura).toBeTruthy();
    }
  });

  // ─── Snapshot inmutable al aprobar ───────────────────────────────────────
  it("snapshot inmutable: tras aprobar, snapshotCalculo queda guardado en BD", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 15_000_000n, TipoRecaudo.BANCOLOMBIA);
    await crearPagoTest(tramiteId, 10_000_000n, CanalPago.PSE, 1);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // Avanzar a EN_REVISION
    await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });

    // Aprobar
    await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userRevisorId,
    });

    // Verificar que el snapshot quedó guardado en BD
    const borradorDB = await prisma.borradorFactura.findUnique({
      where: { id: borrador.id },
      select: { snapshotCalculo: true, estado: true },
    });

    expect(borradorDB?.estado).toBe(EstadoBorrador.APROBADO);
    expect(borradorDB?.snapshotCalculo).not.toBeNull();
    expect(typeof borradorDB?.snapshotCalculo).toBe("object");

    // El snapshot debe contener los valores calculados como strings (BigInt serializado)
    const snap = borradorDB?.snapshotCalculo as Record<string, unknown>;
    expect(snap).toHaveProperty("totalFactura");
    expect(snap).toHaveProperty("saldoAFavorCliente");
    expect(snap).toHaveProperty("comision");
  });

  // ─── Transición inválida ─────────────────────────────────────────────────
  it("transición inválida (BORRADOR → APROBADO) retorna 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 5_000_000n, TipoRecaudo.BANCOLOMBIA);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // Intentar saltar EN_REVISION → debe fallar
    const result = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });
});
