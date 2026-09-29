/**
 * Tests de integración — Ingresos / Libro de bancos (WS-D)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 *
 * TEST_PREFIX: "vitest-ingresos"
 * Año de datos de prueba: 3007
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  CanalPago,
  Ciudad,
  DestinoPago,
  EstadoBorrador,
  Rol,
  TipoCliente,
  TipoPagoFactura,
  TipoRecaudo,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { registrarPagoFacturaAbono } from "@/lib/cartera/service";
import { getIngresos } from "../service";
import { pesos } from "@/lib/dinero";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-ingresos";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3007;

// ─── Fixture ─────────────────────────────────────────────────────────────────

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

  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);

  const facturas = await prisma.factura.findMany({
    where: { borradorId: { in: borradorIds } },
    select: { id: true },
  });
  const facturaIds = facturas.map((f) => f.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
        { entidadId: { in: borradorIds } },
        { entidadId: { in: facturaIds } },
      ],
    },
  });
  await prisma.pagoFactura.deleteMany({
    where: { facturaId: { in: facturaIds } },
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
      email: `${TEST_PREFIX}-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Ingresos Admin",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Ingresos",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ?? "BD local Postgres no disponible para tests de ingresos",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let facturaCounter = 0;

async function crearFacturaDirecta(
  db: Fixture,
  opts: {
    saldoACargoCliente?: bigint;
    saldoAFavorCliente?: bigint;
  } = {},
): Promise<{ facturaId: string; tramiteConsecutivo: string }> {
  facturaCounter++;
  const numero = facturaCounter;

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
    },
  });

  const saldoACargoCliente = opts.saldoACargoCliente ?? 0n;
  const saldoAFavorCliente = opts.saldoAFavorCliente ?? 0n;

  const borrador = await prisma.borradorFactura.create({
    data: {
      tramiteId: tramite.id,
      comisionCentavos: pesos(150_000),
      ivaComisionCentavos: pesos(28_500),
      impuesto4x1000Centavos: 0n,
      costosBancariosCentavos: 0n,
      totalAnticipoCentavos: pesos(5_000_000),
      totalPagosCentavos: pesos(5_000_000),
      totalFacturaCentavos: pesos(5_000_000) + saldoACargoCliente,
      saldoAFavorClienteCentavos: saldoAFavorCliente,
      saldoACargoClienteCentavos: saldoACargoCliente,
      saldoAFavorLMCentavos: 0n,
      saldoACargoLMCentavos: 0n,
      estado: EstadoBorrador.FACTURADO,
      aprobadoPorId: db.userId,
      fechaAprobacion: new Date(`${stateYear}-01-10`),
    },
  });

  const factura = await prisma.factura.create({
    data: {
      borradorId: borrador.id,
      clienteId: db.clienteId,
      numSiigo: `ING-${runId.slice(-6)}-${numero}`,
      fecha: new Date(`${stateYear}-01-15`),
      totalFacturaCentavos: borrador.totalFacturaCentavos,
      saldoAFavorClienteCentavos: saldoAFavorCliente,
      saldoACargoClienteCentavos: saldoACargoCliente,
      saldoAFavorLMCentavos: 0n,
      saldoACargoLMCentavos: 0n,
    },
  });

  return { facturaId: factura.id, tramiteConsecutivo: tramite.consecutivo };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("ingresos service con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no definida";
      return;
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      fixture = await createFixture();
    } catch (error) {
      dbUnavailableReason = `BD local no disponible: ${unavailableMessage(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) {
      await cleanupTestData();
    }
    await prisma.$disconnect();
  });

  // ─── Union de anticipos + abonos ─────────────────────────────────────────

  it("anticipo aparece como entrada positiva en ingresos", async (ctx) => {
    const db = ensureDb(ctx);

    const fechaAnticipo = new Date(`${stateYear}-01-05`);
    await prisma.anticipo.create({
      data: {
        clienteId: db.clienteId,
        montoCentavos: pesos(2_000_000),
        fecha: fechaAnticipo,
        tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
        costoRecaudoCentavos: pesos(1_950),
        verificadoBanco: true,
      },
    });

    const ingresos = await getIngresos({ clienteId: db.clienteId });
    const fila = ingresos.find((f) => f.tipo === "ANTICIPO");

    expect(fila).toBeDefined();
    expect(fila?.montoConSigno).toBe(pesos(2_000_000));
    expect(fila?.montoConSigno).toBeGreaterThan(0n);
  });

  it("abono aparece como entrada positiva en ingresos", async (ctx) => {
    const db = ensureDb(ctx);

    const { facturaId } = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(1_000_000) });

    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(600_000),
      fecha: new Date(`${stateYear}-02-10`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    const ingresos = await getIngresos({ clienteId: db.clienteId });
    const fila = ingresos.find((f) => f.tipo === "ABONO");

    expect(fila).toBeDefined();
    expect(fila?.montoConSigno).toBe(pesos(600_000));
  });

  it("devolución aparece como salida negativa en ingresos", async (ctx) => {
    const db = ensureDb(ctx);

    const { facturaId } = await crearFacturaDirecta(db, { saldoAFavorCliente: pesos(500_000) });

    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: pesos(300_000),
      fecha: new Date(`${stateYear}-03-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    const ingresos = await getIngresos({ clienteId: db.clienteId });
    const fila = ingresos.find((f) => f.tipo === "DEVOLUCION");

    expect(fila).toBeDefined();
    expect(fila?.montoConSigno).toBe(-pesos(300_000));
    expect(fila?.montoConSigno).toBeLessThan(0n);
  });

  it("ingresos ordenados cronológicamente con saldo corrido correcto", async (ctx) => {
    const db = ensureDb(ctx);

    // Crear secuencia limpia: solo para este sub-test usamos filtro de fecha
    const desde = new Date(`${stateYear}-06-01`);
    const hasta = new Date(`${stateYear}-06-30`);

    // Anticipo el día 5
    await prisma.anticipo.create({
      data: {
        clienteId: db.clienteId,
        montoCentavos: pesos(1_000_000),
        fecha: new Date(`${stateYear}-06-05`),
        tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
        costoRecaudoCentavos: pesos(1_950),
        verificadoBanco: false,
      },
    });

    // Factura con abono el día 10
    const { facturaId } = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(800_000) });
    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(500_000),
      fecha: new Date(`${stateYear}-06-10`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    // Factura con saldo a favor y devolución el día 20
    const { facturaId: factura2Id } = await crearFacturaDirecta(db, { saldoAFavorCliente: pesos(200_000) });
    await registrarPagoFacturaAbono({
      facturaId: factura2Id,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: pesos(200_000),
      fecha: new Date(`${stateYear}-06-20`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    const ingresos = await getIngresos({ clienteId: db.clienteId, desde, hasta });

    // Verificar orden cronológico
    for (let i = 1; i < ingresos.length; i++) {
      expect(ingresos[i].fecha.getTime()).toBeGreaterThanOrEqual(ingresos[i - 1].fecha.getTime());
    }

    // Verificar saldo corrido: anticipo 1.000.000 + abono 500.000 - devolucion 200.000 = 1.300.000
    const ultimaFila = ingresos[ingresos.length - 1];
    expect(ultimaFila.saldoCorrido).toBe(pesos(1_300_000));
  });

  it("filtro por clienteId devuelve solo filas de ese cliente", async (ctx) => {
    const db = ensureDb(ctx);

    const ingresos = await getIngresos({ clienteId: db.clienteId });

    for (const fila of ingresos) {
      expect(fila.clienteId).toBe(db.clienteId);
    }
  });

  it("filtro por fechas recorta el rango correctamente", async (ctx) => {
    const db = ensureDb(ctx);

    const desde = new Date(`${stateYear}-05-01`);
    const hasta = new Date(`${stateYear}-05-31`);

    const ingresos = await getIngresos({ clienteId: db.clienteId, desde, hasta });

    for (const fila of ingresos) {
      expect(fila.fecha.getTime()).toBeGreaterThanOrEqual(desde.getTime());
      expect(fila.fecha.getTime()).toBeLessThanOrEqual(hasta.getTime());
    }
  });
});
