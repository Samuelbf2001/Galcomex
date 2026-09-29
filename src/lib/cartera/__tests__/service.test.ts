/**
 * Tests de integración — Cartera (WS-D)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-cartera"
 * Año de datos de prueba: 3004 (no colisiona con datos reales)
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
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  calcularSaldoNeto,
  eliminarPagoFactura,
  getCarteraCliente,
  getFacturaConPagos,
  registrarPagoFactura,
  registrarPagoFacturaAbono,
} from "../service";
import { pesos } from "@/lib/dinero";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-cartera";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3004;

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
      name: "Vitest Cartera Admin",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Cartera",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ?? "BD local Postgres no disponible para tests de cartera",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }

  return fixture;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let facturaCounter = 0;

/**
 * Crea una Factura directamente en BD (saltando el flujo borrador)
 * para poblar cartera en los tests.
 */
async function crearFacturaDirecta(
  db: Fixture,
  {
    saldoAFavorCliente = 0n,
    saldoACargoCliente = 0n,
    saldoAFavorLM = 0n,
    saldoACargoLM = 0n,
    fechaPagoCliente = null,
  }: {
    saldoAFavorCliente?: bigint;
    saldoACargoCliente?: bigint;
    saldoAFavorLM?: bigint;
    saldoACargoLM?: bigint;
    fechaPagoCliente?: Date | null;
  } = {},
): Promise<string> {
  facturaCounter++;
  const numero = facturaCounter;

  // Crear tramite
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

  // Crear borrador
  const borrador = await prisma.borradorFactura.create({
    data: {
      tramiteId: tramite.id,
      comisionCentavos: pesos(150_000),
      ivaComisionCentavos: pesos(28_500),
      impuesto4x1000Centavos: 0n,
      costosBancariosCentavos: 0n,
      totalAnticipoCentavos: pesos(10_000_000),
      totalPagosCentavos: pesos(10_000_000),
      totalFacturaCentavos: saldoAFavorCliente > 0n
        ? pesos(10_000_000) - saldoAFavorCliente
        : pesos(10_000_000) + saldoACargoCliente,
      saldoAFavorClienteCentavos: saldoAFavorCliente,
      saldoACargoClienteCentavos: saldoACargoCliente,
      saldoAFavorLMCentavos: saldoAFavorLM,
      saldoACargoLMCentavos: saldoACargoLM,
      estado: EstadoBorrador.FACTURADO,
      aprobadoPorId: db.userId,
      fechaAprobacion: new Date(`${stateYear}-01-10`),
    },
  });

  // Crear factura
  const factura = await prisma.factura.create({
    data: {
      borradorId: borrador.id,
      clienteId: db.clienteId,
      numSiigo: `TST-${runId.slice(-6)}-${numero}`,
      fecha: new Date(`${stateYear}-01-15`),
      totalFacturaCentavos: borrador.totalFacturaCentavos,
      saldoAFavorClienteCentavos: saldoAFavorCliente,
      saldoACargoClienteCentavos: saldoACargoCliente,
      saldoAFavorLMCentavos: saldoAFavorLM,
      saldoACargoLMCentavos: saldoACargoLM,
      fechaPagoCliente,
    },
  });

  return factura.id;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("cartera service con Postgres local", () => {
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

  // ─── Helper saldoNeto: función pura (sin BD) ──────────────────────────────

  it("calcularSaldoNeto: sin pagos devuelve saldoAFavor - saldoACargo", () => {
    // Caso: saldo a cargo del cliente
    expect(calcularSaldoNeto({
      saldoAFavor: 0n,
      saldoACargo: pesos(500_000),
      abonos: 0n,
      devoluciones: 0n,
    })).toBe(-pesos(500_000));

    // Caso: saldo a favor del cliente (Galcomex debe)
    expect(calcularSaldoNeto({
      saldoAFavor: pesos(3_357_958),
      saldoACargo: 0n,
      abonos: 0n,
      devoluciones: 0n,
    })).toBe(pesos(3_357_958));

    // Caso: saldado (sin pagos, saldos iguales)
    expect(calcularSaldoNeto({
      saldoAFavor: pesos(100_000),
      saldoACargo: pesos(100_000),
      abonos: 0n,
      devoluciones: 0n,
    })).toBe(0n);
  });

  it("calcularSaldoNeto: abono reduce el pendiente de cobro", () => {
    // Cargo 500.000, abono 200.000 → pendiente cobro 300.000
    expect(calcularSaldoNeto({
      saldoAFavor: 0n,
      saldoACargo: pesos(500_000),
      abonos: pesos(200_000),
      devoluciones: 0n,
    })).toBe(-pesos(300_000));
  });

  it("calcularSaldoNeto: abono exacto salda (saldoNeto = 0)", () => {
    expect(calcularSaldoNeto({
      saldoAFavor: 0n,
      saldoACargo: pesos(500_000),
      abonos: pesos(500_000),
      devoluciones: 0n,
    })).toBe(0n);
  });

  it("calcularSaldoNeto: sobrepago → saldoNeto positivo (Galcomex debe devolver)", () => {
    expect(calcularSaldoNeto({
      saldoAFavor: 0n,
      saldoACargo: pesos(500_000),
      abonos: pesos(700_000),
      devoluciones: 0n,
    })).toBe(pesos(200_000));
  });

  it("calcularSaldoNeto: golden case — saldoAFavor 3.357.958, devolucion salda", () => {
    // Factura con saldo a favor del cliente = 3.357.958
    // Devolución de 3.357.958 → saldoNeto = 0
    expect(calcularSaldoNeto({
      saldoAFavor: pesos(3_357_958),
      saldoACargo: 0n,
      abonos: 0n,
      devoluciones: pesos(3_357_958),
    })).toBe(0n);
  });

  it("calcularSaldoNeto: devolución parcial del saldo a favor", () => {
    expect(calcularSaldoNeto({
      saldoAFavor: pesos(3_357_958),
      saldoACargo: 0n,
      abonos: 0n,
      devoluciones: pesos(1_000_000),
    })).toBe(pesos(2_357_958));
  });

  // ─── Cartera con facturas mixtas (a cargo y a favor) ─────────────────────

  it("cruce correcto: cliente con 3 facturas a cargo y 2 a favor calcula cruce exacto", async (ctx) => {
    const db = ensureDb(ctx);

    // 3 facturas a cargo del cliente
    await crearFacturaDirecta(db, { saldoACargoCliente: pesos(500_000) });
    await crearFacturaDirecta(db, { saldoACargoCliente: pesos(300_000) });
    await crearFacturaDirecta(db, { saldoACargoCliente: pesos(200_000) });

    // 2 facturas a favor del cliente (Galcomex debe)
    await crearFacturaDirecta(db, { saldoAFavorCliente: pesos(150_000) });
    await crearFacturaDirecta(db, { saldoAFavorCliente: pesos(250_000) });

    const cartera = await getCarteraCliente({ clienteId: db.clienteId });

    // cruceCliente = Σ saldoNetoCliente
    // = (-500.000) + (-300.000) + (-200.000) + 150.000 + 250.000
    // = -600.000 (el cliente debe a Galcomex, es negativo en convención saldoNeto)
    // PERO el cruce histórico era positivo cuando cliente debe.
    // Con el nuevo ledger: saldoNeto < 0 → cliente debe → pendiente de cobro.
    // cruceCliente = suma de saldoNeto = -600.000
    const sumACargo = pesos(500_000) + pesos(300_000) + pesos(200_000);
    const sumAFavor = pesos(150_000) + pesos(250_000);
    // saldoNeto por factura: -(saldoACargo) + saldoAFavor
    // El cruce = Σ saldoNeto = Σ(saldoAFavor - saldoACargo) = sumAFavor - sumACargo
    const cruceEsperado = sumAFavor - sumACargo; // -600.000

    expect(cartera.cruceCliente).toBe(cruceEsperado);
    expect(cartera.cruceCliente).toBe(-pesos(600_000));
    expect(cartera.totalFacturas).toBeGreaterThanOrEqual(5);
  });

  // ─── Abono parcial reduce pendiente ──────────────────────────────────────

  it("abono parcial reduce pendiente de cobro", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(1_000_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(400_000),
      fecha: new Date(`${stateYear}-02-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // saldoNeto = (0 - 1.000.000) + 400.000 - 0 = -600.000
      expect(result.saldoNeto).toBe(-pesos(600_000));
      // No se saldó aún
      expect(result.factura.fechaPagoCliente).toBeNull();
    }

    const detalle = await getFacturaConPagos(facturaId);
    expect(detalle?.pendienteCobroCliente).toBe(pesos(600_000));
    expect(detalle?.pendienteDevolucionCliente).toBe(0n);
  });

  // ─── Varios abonos hasta saldar setean fechaPago ──────────────────────────

  it("varios abonos hasta saldar setean fechaPagoCliente", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(900_000) });

    // Primer abono parcial
    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(300_000),
      fecha: new Date(`${stateYear}-02-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    // Segundo abono parcial
    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(300_000),
      fecha: new Date(`${stateYear}-02-15`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    // Tercer abono que salda
    const fechaPago = new Date(`${stateYear}-03-01`);
    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(300_000),
      fecha: fechaPago,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.saldoNeto).toBe(0n);
      expect(result.factura.fechaPagoCliente).toBeTruthy();
    }

    // Ya no aparece en pendientes
    const cartera = await getCarteraCliente({ clienteId: db.clienteId, soloPendientes: true });
    const ids = cartera.facturas.map((f) => f.id);
    expect(ids).not.toContain(facturaId);
  });

  // ─── Sobrepago → pendiente de devolución ─────────────────────────────────

  it("sobrepago genera pendiente de devolución (no es error)", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(500_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(700_000), // 200.000 de sobrepago
      fecha: new Date(`${stateYear}-02-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // saldoNeto = (0 - 500.000) + 700.000 = 200.000 > 0 → Galcomex debe devolver
      expect(result.saldoNeto).toBe(pesos(200_000));
      // Se marca como "saldada" en fecha del abono (saldo a favor = 200.000, no 0)
      // En realidad saldoNeto != 0, entonces fechaPago no se setea
      expect(result.factura.fechaPagoCliente).toBeNull();
    }

    const detalle = await getFacturaConPagos(facturaId);
    expect(detalle?.pendienteDevolucionCliente).toBe(pesos(200_000));
    expect(detalle?.pendienteCobroCliente).toBe(0n);
  });

  // ─── Golden case: saldo a favor 3.357.958 → devolución lo salda ──────────

  it("golden case: devolución de 3.357.958 salda factura con saldo a favor", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoAFavorCliente: pesos(3_357_958) });

    // saldoNeto inicial = 3.357.958 (Galcomex debe devolver)
    const detaleInicial = await getFacturaConPagos(facturaId);
    expect(detaleInicial?.saldoNetoCliente).toBe(pesos(3_357_958));

    // Devolver exactamente el saldo a favor
    const fechaDev = new Date(`${stateYear}-04-01`);
    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: pesos(3_357_958),
      fecha: fechaDev,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.saldoNeto).toBe(0n);
      expect(result.factura.fechaPagoCliente).toBeTruthy();
    }

    // Verificar que ya no aparece en pendientes
    const cartera = await getCarteraCliente({ clienteId: db.clienteId, soloPendientes: true });
    const ids = cartera.facturas.map((f) => f.id);
    expect(ids).not.toContain(facturaId);
  });

  // ─── Devolución que excede saldo a favor → 422 ───────────────────────────

  it("devolución que excede saldo a favor → 422", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoAFavorCliente: pesos(1_000_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: pesos(1_500_000), // excede el saldo a favor
      fecha: new Date(`${stateYear}-04-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  it("devolución sin saldo a favor disponible → 422", async (ctx) => {
    const db = ensureDb(ctx);

    // Factura con saldo a cargo (Galcomex no debe nada, el cliente debe)
    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(500_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: pesos(100_000),
      fecha: new Date(`${stateYear}-04-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  // ─── Eliminar pago revierte el saldo ─────────────────────────────────────

  it("eliminar pago revierte saldoNeto y limpia fechaPago", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(500_000) });

    // Pagar completo → saldoNeto = 0, fechaPago setada
    const r1 = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(500_000),
      fecha: new Date(`${stateYear}-02-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.saldoNeto).toBe(0n);
      expect(r1.factura.fechaPagoCliente).toBeTruthy();
    }

    // Eliminar el pago → saldoNeto vuelve a -500.000, fechaPago limpiada
    const pagoId = r1.ok ? r1.pago.id : "";
    const r2 = await eliminarPagoFactura(pagoId, db.userId);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.saldoNeto).toBe(-pesos(500_000));
      expect(r2.factura.fechaPagoCliente).toBeNull();
    }

    // Vuelve a aparecer en pendientes
    const cartera = await getCarteraCliente({ clienteId: db.clienteId, soloPendientes: true });
    const ids = cartera.facturas.map((f) => f.id);
    expect(ids).toContain(facturaId);
  });

  // ─── eliminarPagoFactura con ID inexistente → 404 ────────────────────────

  it("eliminarPagoFactura con ID inexistente retorna 404", async (ctx) => {
    const db = ensureDb(ctx);

    const result = await eliminarPagoFactura("id-inexistente", db.userId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  // ─── getCarteraCliente con abonos calcula cruce correcto ─────────────────

  it("getCarteraCliente con abonos calcula saldoNeto y pendientes correctamente", async (ctx) => {
    const db = ensureDb(ctx);

    // Factura con cargo 1.000.000; abono de 400.000
    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(1_000_000) });
    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(400_000),
      fecha: new Date(`${stateYear}-02-01`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    const cartera = await getCarteraCliente({ clienteId: db.clienteId });
    const f = cartera.facturas.find((x) => x.id === facturaId);

    expect(f).toBeDefined();
    expect(f?.saldoNetoCliente).toBe(-pesos(600_000));
    expect(f?.pendienteCobroCliente).toBe(pesos(600_000));
    expect(f?.abonosCliente).toBe(pesos(400_000));
  });

  // ─── LM independiente: solo registrar fechaPagoLM ────────────────────────

  it("registrar fechaPagoLM es independiente de fechaPagoCliente (legacy)", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, {
      saldoAFavorLM: pesos(50_000),
    });

    // Solo registrar pago de LM (endpoint legacy — escribe fecha directamente)
    const result = await registrarPagoFactura({
      facturaId,
      fechaPagoLM: new Date(`${stateYear}-03-01`),
      usuarioId: db.userId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.factura.fechaPagoLM).toBeTruthy();
      expect(result.factura.fechaPagoCliente).toBeNull();
    }
  });

  // ─── cruceLM correcto ─────────────────────────────────────────────────────

  it("cruceLM se calcula correctamente con saldos LM mixtos", async (ctx) => {
    const db = ensureDb(ctx);

    await crearFacturaDirecta(db, { saldoACargoLM: pesos(800_000) });
    await crearFacturaDirecta(db, { saldoACargoLM: pesos(400_000) });
    await crearFacturaDirecta(db, { saldoAFavorLM: pesos(300_000) });

    const cartera = await getCarteraCliente({ clienteId: db.clienteId });

    expect(typeof cartera.cruceLM).toBe("bigint");
    // Verificamos que el cruce es coherente con los saldoNeto de las facturas
    const cruceLMCalculado = cartera.facturas.reduce(
      (acc, f) => acc + f.saldoNetoLM,
      0n,
    );
    expect(cartera.cruceLM).toBe(cruceLMCalculado);
  });

  // ─── Factura no encontrada → 404 ─────────────────────────────────────────

  it("registrarPagoFactura (legacy) con ID inexistente retorna status 404", async (ctx) => {
    const db = ensureDb(ctx);

    const result = await registrarPagoFactura({
      facturaId: "id-inexistente-vitest",
      fechaPagoCliente: new Date(),
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it("registrarPagoFacturaAbono con ID de factura inexistente retorna 404", async (ctx) => {
    const db = ensureDb(ctx);

    const result = await registrarPagoFacturaAbono({
      facturaId: "id-inexistente-vitest-abono",
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(100_000),
      fecha: new Date(),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  // ─── NUEVOS TESTS: tipoRecaudo, costoBancario y totalRealLM ──────────────

  it("registrar pago con tipoRecaudo snapshotea costoBancario desde matriz_recaudo", async (ctx) => {
    const db = ensureDb(ctx);

    // Verificar que la matriz_recaudo tiene datos para BANCOLOMBIA (costo=1950)
    const matrizBancolombia = await prisma.matrizRecaudo.findUnique({
      where: { tipoRecaudo: "BANCOLOMBIA" },
    });
    if (!matrizBancolombia) {
      ctx.skip("matriz_recaudo no tiene fila BANCOLOMBIA; omitiendo test.");
      return;
    }

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(500_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(200_000),
      fecha: new Date(`${stateYear}-05-01`),
      tipoRecaudo: "BANCOLOMBIA",
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // costoBancario debe ser el snapshot de matrix_recaudo para BANCOLOMBIA
      expect(result.pago.costoBancarioCentavos).toBe(matrizBancolombia.costoFijoCentavos);
      expect(result.pago.tipoRecaudo).toBe("BANCOLOMBIA");
      expect(result.pago.canalPago).toBeNull();
    }
  });

  it("registrar pago con canalPago snapshotea costoBancario desde matriz_pago", async (ctx) => {
    const db = ensureDb(ctx);

    // Verificar que la matriz_pago tiene datos para TRANSF_BANCOLOMBIA (costo=3900)
    const matrizTransf = await prisma.matrizPago.findUnique({
      where: { canalPago: "TRANSF_BANCOLOMBIA" },
    });
    if (!matrizTransf) {
      ctx.skip("matriz_pago no tiene fila TRANSF_BANCOLOMBIA; omitiendo test.");
      return;
    }

    const facturaId = await crearFacturaDirecta(db, { saldoACargoLM: pesos(300_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.LM,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(150_000),
      fecha: new Date(`${stateYear}-05-02`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // costoBancario debe ser el snapshot de matriz_pago para TRANSF_BANCOLOMBIA
      expect(result.pago.costoBancarioCentavos).toBe(matrizTransf.costoFijoCentavos);
      expect(result.pago.canalPago).toBe("TRANSF_BANCOLOMBIA");
      expect(result.pago.tipoRecaudo).toBeNull();
    }
  });

  it("totalRealLM = saldoNetoLM − costosBancariosCliente − costosBancariosLM", async (ctx) => {
    const db = ensureDb(ctx);

    // Factura con cargos en ambos destinos
    const facturaId = await crearFacturaDirecta(db, {
      saldoACargoCliente: pesos(1_000_000),
      saldoACargoLM: pesos(500_000),
    });

    // Abono cliente con PSE (costo=0); si no hay datos en BD usar canalPago directamente
    const matrizPSE = await prisma.matrizPago.findUnique({
      where: { canalPago: "PSE" },
    });

    // Pago de cliente: TRANSF_BANCOLOMBIA → costo 3900
    const matrizTransf = await prisma.matrizPago.findUnique({
      where: { canalPago: "TRANSF_BANCOLOMBIA" },
    });

    // Si no hay matriz cargada, los costos serán 0 (snapshot desde BD = 0)
    const costoEsperadoCliente = matrizTransf?.costoFijoCentavos ?? 0n;
    const costoEsperadoPSE = matrizPSE?.costoFijoCentavos ?? 0n;

    // Pago de cliente con TRANSF_BANCOLOMBIA
    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(1_000_000),
      fecha: new Date(`${stateYear}-05-03`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    // Pago de LM con PSE
    await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.LM,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(500_000),
      fecha: new Date(`${stateYear}-05-04`),
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });

    const detalle = await getFacturaConPagos(facturaId);
    expect(detalle).not.toBeNull();

    if (detalle) {
      // saldoNetoLM: abono 500.000 salda cargo 500.000 → saldoNeto = 0
      expect(detalle.saldoNetoLM).toBe(0n);
      expect(detalle.costosBancariosCliente).toBe(costoEsperadoCliente);
      expect(detalle.costosBancariosLM).toBe(costoEsperadoPSE);
      // totalRealLM = 0 − costoEsperadoCliente − costoEsperadoPSE
      expect(detalle.totalRealLM).toBe(
        detalle.saldoNetoLM - detalle.costosBancariosCliente - detalle.costosBancariosLM,
      );
    }
  });

  it("validación: pasar tipoRecaudo Y canalPago → retorna 400", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(100_000) });

    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(50_000),
      fecha: new Date(`${stateYear}-05-05`),
      // Ambos seteados → debe rechazarse
      tipoRecaudo: "BANCOLOMBIA",
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("validación: no pasar ni tipoRecaudo ni canalPago → retorna 400", async (ctx) => {
    const db = ensureDb(ctx);

    const facturaId = await crearFacturaDirecta(db, { saldoACargoCliente: pesos(100_000) });

    // Forzamos ninguno pasando undefined explícitamente
    const result = await registrarPagoFacturaAbono({
      facturaId,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: pesos(50_000),
      fecha: new Date(`${stateYear}-05-06`),
      // tipoRecaudo: undefined → omitido
      // canalPago: undefined → omitido
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });
});
