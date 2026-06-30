/**
 * Tests de integración — Conciliación batch (lote) de cartera
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, los tests de integración se omiten (skip).
 * Los tests de schema (Zod puro) corren siempre.
 *
 * TEST_PREFIX único: "vitest-lote"
 * Año de datos de prueba: 3005 (no colisiona con datos reales ni con service.test.ts)
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
import { conciliarLoteSchema } from "@/lib/validations/cartera";

import { conciliarLoteFacturas } from "../service";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-lote";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3005;

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
        { entidad: "ConciliacionBatchCartera", usuarioId: { in: userIds } },
      ],
    },
  });
  await prisma.pagoFactura.deleteMany({
    where: { facturaId: { in: facturaIds } },
  });
  await prisma.factura.deleteMany({
    where: { borradorId: { in: borradorIds } },
  });
  await prisma.borradorFactura.deleteMany({
    where: { id: { in: borradorIds } },
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
      name: "Vitest Lote Admin",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Lote",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ?? "BD local Postgres no disponible para tests de lote",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }

  return fixture;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let facturaCounter = 0;

async function crearFacturaDirecta(
  db: Fixture,
  {
    saldoAFavorCliente = 0n,
    saldoACargoCliente = 0n,
    saldoAFavorLM = 0n,
    saldoACargoLM = 0n,
  }: {
    saldoAFavorCliente?: bigint;
    saldoACargoCliente?: bigint;
    saldoAFavorLM?: bigint;
    saldoACargoLM?: bigint;
  } = {},
): Promise<string> {
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

  const borrador = await prisma.borradorFactura.create({
    data: {
      tramiteId: tramite.id,
      comision: 150_000n,
      ivaComision: 28_500n,
      impuesto4x1000: 0n,
      costosBancarios: 0n,
      totalAnticipo: 10_000_000n,
      totalPagos: 10_000_000n,
      totalFactura:
        saldoAFavorCliente > 0n
          ? 10_000_000n - saldoAFavorCliente
          : 10_000_000n + saldoACargoCliente,
      saldoAFavorCliente,
      saldoACargoCliente,
      saldoAFavorLM,
      saldoACargoLM,
      estado: EstadoBorrador.FACTURADO,
      aprobadoPorId: db.userId,
      fechaAprobacion: new Date(`${stateYear}-01-10`),
    },
  });

  const factura = await prisma.factura.create({
    data: {
      borradorId: borrador.id,
      clienteId: db.clienteId,
      numSiigo: `LOT-${runId.slice(-6)}-${numero}`,
      fecha: new Date(`${stateYear}-01-15`),
      totalFactura: borrador.totalFactura,
      saldoAFavorCliente,
      saldoACargoCliente,
      saldoAFavorLM,
      saldoACargoLM,
    },
  });

  return factura.id;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("conciliarLoteFacturas (integración con Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason =
        "DATABASE_URL no está definida; se omiten tests de integración";
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

  // ─── Casos felices ────────────────────────────────────────────────────────

  it("lote 3 facturas saldables: todas ok, fechaPagoCliente seteada en todas", async (ctx) => {
    const db = ensureDb(ctx);

    const f1 = await crearFacturaDirecta(db, { saldoACargoCliente: 500_000n });
    const f2 = await crearFacturaDirecta(db, { saldoACargoCliente: 300_000n });
    const f3 = await crearFacturaDirecta(db, { saldoACargoCliente: 200_000n });

    const fecha = new Date(`${stateYear}-02-01`);

    const result = await conciliarLoteFacturas({
      items: [
        {
          facturaId: f1,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 500_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
        {
          facturaId: f2,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 300_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
        {
          facturaId: f3,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 200_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
      ],
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(3);
    expect(result.results.every((r) => r.ok)).toBe(true);

    // Verificar que las 3 facturas quedaron con fechaPagoCliente seteada
    const facturas = await prisma.factura.findMany({
      where: { id: { in: [f1, f2, f3] } },
      select: { id: true, fechaPagoCliente: true },
    });
    expect(facturas).toHaveLength(3);
    expect(facturas.every((f) => f.fechaPagoCliente !== null)).toBe(true);
  });

  it("lote parcial: ítem 2 falla por devolución > pendiente, ítems 1 y 3 ok", async (ctx) => {
    const db = ensureDb(ctx);

    // f1 y f3 tienen saldoACargo (cliente debe) — abonable
    const f1 = await crearFacturaDirecta(db, { saldoACargoCliente: 100_000n });
    const f2 = await crearFacturaDirecta(db, { saldoAFavorCliente: 50_000n });
    const f3 = await crearFacturaDirecta(db, { saldoACargoCliente: 200_000n });

    const fecha = new Date(`${stateYear}-02-15`);

    const result = await conciliarLoteFacturas({
      items: [
        {
          facturaId: f1,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 100_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
        {
          // f2 tiene saldoAFavor 50.000 → devolución de 999.999 excede
          facturaId: f2,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.DEVOLUCION,
          monto: 999_999n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
        {
          facturaId: f3,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 200_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
      ],
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);

    const r1 = result.results.find((r) => r.facturaId === f1);
    const r2 = result.results.find((r) => r.facturaId === f2);
    const r3 = result.results.find((r) => r.facturaId === f3);

    expect(r1?.ok).toBe(true);
    expect(r3?.ok).toBe(true);
    expect(r2?.ok).toBe(false);
    if (r2 && !r2.ok) {
      expect(r2.status).toBe(422);
      expect(r2.error).toMatch(/devoluci[óo]n|excede/i);
    }

    // Verificar AuditLog paraguas con status=PARCIAL
    const lote = await prisma.auditLog.findUnique({
      where: { id: result.loteAuditId },
    });
    expect(lote).not.toBeNull();
    expect(lote?.entidad).toBe("ConciliacionBatchCartera");
    const despues = lote?.despues as Record<string, unknown>;
    expect(despues.status).toBe("PARCIAL");
    expect(Array.isArray(despues.pagoIds)).toBe(true);
    expect((despues.pagoIds as string[]).length).toBe(2);
    expect(Array.isArray(despues.errores)).toBe(true);
    expect((despues.errores as unknown[]).length).toBe(1);
  });

  it("lote mixto destinos (CLIENTE y LM) sobre la misma factura: ambos exitosos", async (ctx) => {
    const db = ensureDb(ctx);

    const f = await crearFacturaDirecta(db, {
      saldoACargoCliente: 100_000n,
      saldoACargoLM: 80_000n,
    });

    const fecha = new Date(`${stateYear}-03-01`);

    const result = await conciliarLoteFacturas({
      items: [
        {
          facturaId: f,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 100_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
        {
          facturaId: f,
          destino: DestinoPago.LM,
          tipo: TipoPagoFactura.ABONO,
          monto: 80_000n,
          fecha,
          canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        },
      ],
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(2);
    expect(result.failed).toBe(0);

    const factura = await prisma.factura.findUnique({
      where: { id: f },
      select: { fechaPagoCliente: true, fechaPagoLM: true },
    });
    expect(factura?.fechaPagoCliente).not.toBeNull();
    expect(factura?.fechaPagoLM).not.toBeNull();
  });

  it("AuditLog paraguas: status=COMPLETADO cuando todo va bien", async (ctx) => {
    const db = ensureDb(ctx);

    const f = await crearFacturaDirecta(db, { saldoACargoCliente: 50_000n });

    const result = await conciliarLoteFacturas({
      items: [
        {
          facturaId: f,
          destino: DestinoPago.CLIENTE,
          tipo: TipoPagoFactura.ABONO,
          monto: 50_000n,
          fecha: new Date(`${stateYear}-03-10`),
          tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
        },
      ],
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(1);
    const lote = await prisma.auditLog.findUnique({
      where: { id: result.loteAuditId },
    });
    const despues = lote?.despues as Record<string, unknown>;
    expect(despues.status).toBe("COMPLETADO");
    expect(despues.failed).toBe(0);

    // entidadId debe ser igual al id propio (para que el índice [entidad, entidadId] sea útil)
    expect(lote?.entidadId).toBe(lote?.id);
  });
});

// ─── Tests del schema Zod (sin BD) ─────────────────────────────────────────────

describe("conciliarLoteSchema (sin BD)", () => {
  const validItem = {
    facturaId: "fac_1",
    destino: "CLIENTE",
    tipo: "ABONO",
    monto: "500000",
    fecha: "2026-01-15",
    canalPago: "TRANSF_BANCOLOMBIA",
    verificadoBanco: false,
  };

  it("rechaza lote vacío", () => {
    const r = conciliarLoteSchema.safeParse({ items: [] });
    expect(r.success).toBe(false);
  });

  it("rechaza lote con (facturaId, destino) duplicado", () => {
    const r = conciliarLoteSchema.safeParse({
      items: [validItem, { ...validItem }],
    });
    expect(r.success).toBe(false);
  });

  it("acepta misma factura con destinos distintos", () => {
    const r = conciliarLoteSchema.safeParse({
      items: [
        validItem,
        { ...validItem, destino: "LM" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rechaza ítem con XOR violado (ambos seteados)", () => {
    const r = conciliarLoteSchema.safeParse({
      items: [
        {
          ...validItem,
          tipoRecaudo: "BANCOLOMBIA",
          canalPago: "TRANSF_BANCOLOMBIA",
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza ítem con XOR violado (ninguno seteado)", () => {
    const itemSinCanal: Record<string, unknown> = { ...validItem };
    delete itemSinCanal.canalPago;
    const r = conciliarLoteSchema.safeParse({
      items: [itemSinCanal],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza monto <= 0", () => {
    const r = conciliarLoteSchema.safeParse({
      items: [{ ...validItem, monto: "0" }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza más de 50 ítems", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      ...validItem,
      facturaId: `fac_${i}`,
    }));
    const r = conciliarLoteSchema.safeParse({ items });
    expect(r.success).toBe(false);
  });

  it("acepta lote válido con un único ítem", () => {
    const r = conciliarLoteSchema.safeParse({ items: [validItem] });
    expect(r.success).toBe(true);
  });
});
