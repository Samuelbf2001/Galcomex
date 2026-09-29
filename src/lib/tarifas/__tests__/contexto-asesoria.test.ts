/**
 * Tests de integración — Contexto del motor de tarifas con asesoría «NO SE
 * COBRA» (caso Ascinter): un ítem ESPEJO_DE_COSTO nunca refleja lo que no se
 * le cobra al cliente.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida. Si la BD no
 * está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-tarifas-contexto"
 * Año de datos de prueba: 3017 (no colisiona con datos reales ni con otros tests)
 */
import "dotenv/config";

import { AgenciaAduanas, CanalPago, Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

import { calcularLineasTarifa, type ItemTarifaCalculable } from "../motor";
import { contextoDeTramite } from "../service";

const TEST_PREFIX = "vitest-tarifas-contexto";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3017;

type Fixture = { userId: string; clienteId: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupTestData() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const clientes = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const tramites = await prisma.tramiteDO.findMany({
    where: {
      OR: [
        { clienteId: { in: clientes.map((c) => c.id) } },
        { comentarios: { startsWith: TEST_PREFIX } },
      ],
    },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);

  // Los enlaces pago↔factura caen en cascada con el pago.
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clientes.map((c) => c.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-admin-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Tarifas Contexto",
      rol: Rol.ADMIN,
    },
  });
  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Tarifas Contexto", nit: `${TEST_PREFIX}-${runId}`, tipo: TipoCliente.PROPIO },
  });
  return { userId: user.id, clienteId: cliente.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de tarifas");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

let tramiteCounter = 0;

async function crearTramite(db: Fixture): Promise<string> {
  tramiteCounter++;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(tramiteCounter).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero: tramiteCounter,
      clienteId: db.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.userId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado: EstadoTramite.EN_TRAMITE,
    },
  });
  return tramite.id;
}

async function crearFactura(
  db: Fixture,
  tramiteId: string,
  concepto: string,
  valor: bigint,
  repercutible: boolean,
): Promise<string> {
  const factura = await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "ASCINTER VITEST",
      numFactura: `${concepto}-${runId}-${Math.random().toString(36).slice(2)}`,
      concepto,
      valor,
      fecha: new Date(`${stateYear}-01-15`),
      repercutible,
      subidaPorId: db.userId,
    },
  });
  return factura.id;
}

async function crearPago(
  tramiteId: string,
  concepto: string,
  valor: bigint,
  orden: number,
  facturaIds: string[] = [],
): Promise<void> {
  await prisma.pagoTramite.create({
    data: {
      tramiteId,
      concepto,
      valor,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      costoBancario: 3_900n,
      orden,
      // Enlace heredado (monto 0 = la migración de CxP v2 no pudo repartirlo).
      facturasProveedor: { create: facturaIds.map((facturaId) => ({ facturaId, monto: 0n })) },
    },
  });
}

function espejo(conceptoCosto: string): ItemTarifaCalculable {
  return {
    concepto: `ESPEJO_${conceptoCosto.toUpperCase()}`,
    nombrePublico: `Espejo ${conceptoCosto}`,
    siigoCodigo: null,
    tipoCalculo: "ESPEJO_DE_COSTO",
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto,
    tramos: null,
    aplicaIva: false,
    orden: 10,
  };
}

describe("contextoDeTramite — costos espejables sin asesoría NO SE COBRA, con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida; se omiten tests de integración con Postgres";
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
    if (dbConnected) await cleanupTestData();
    await prisma.$disconnect();
  });

  it("excluye las facturas NO SE COBRA y de cada pago toma solo su parte cobrable", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramite(db);

    const asesoriaVuce = await crearFactura(db, tramiteId, "Asesoría VUCE", 300_000n, false);
    const transporte = await crearFactura(db, tramiteId, "Transporte terrestre", 1_000_000n, true);
    const asesoria2 = await crearFactura(db, tramiteId, "Honorarios Ascinter", 300_000n, false);

    // 1. Pago de solo asesoría: no se le cobra nada al cliente → no aparece
    //    (ni con 0: taparía al registro VUCE de abajo, que tiene el mismo concepto).
    await crearPago(tramiteId, "Pago VUCE Ascinter", 300_000n, 1, [asesoriaVuce]);
    // 2. Pago suelto: completo, como siempre.
    await crearPago(tramiteId, "Registro VUCE", 230_000n, 2);
    // 3. Pago en bloque transporte + asesoría: solo el transporte (1.000.000).
    await crearPago(tramiteId, "Bloque Ascinter", 1_300_000n, 3, [transporte, asesoria2]);

    const contexto = await contextoDeTramite(tramiteId);
    expect(contexto.costos.map(({ concepto, valor }) => ({ concepto, valor }))).toEqual([
      { concepto: "Registro VUCE", valor: 230_000n },
      { concepto: "Bloque Ascinter", valor: 1_000_000n },
      { concepto: "Transporte terrestre", valor: 1_000_000n },
    ]);

    const resultado = calcularLineasTarifa(
      [espejo("VUCE"), espejo("Bloque"), espejo("Asesoría"), espejo("Honorarios")],
      contexto,
    );
    // Antes: el espejo de "VUCE" tomaba la asesoría (300.000) y el del bloque 1.300.000.
    expect(Object.fromEntries(resultado.lineas.map((l) => [l.concepto, l.valor]))).toEqual({
      ESPEJO_VUCE: 230_000n,
      ESPEJO_BLOQUE: 1_000_000n,
    });
    // La asesoría nunca se espeja: sin costo que la refleje, queda pendiente.
    expect(resultado.pendientes.map((p) => p.concepto).sort()).toEqual([
      "ESPEJO_ASESORÍA",
      "ESPEJO_HONORARIOS",
    ]);
  });

  it("trámite sin asesoría: pagos sueltos y 100 % repercutibles van completos, como antes", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramite(db);

    const transporte = await crearFactura(db, tramiteId, "Transporte terrestre", 1_000_000n, true);
    await crearPago(tramiteId, "Registro VUCE", 230_000n, 1);
    // Mayor que su factura: se cobra (y se espeja) completo, regla R2.
    await crearPago(tramiteId, "Transferencia transporte", 1_200_000n, 2, [transporte]);
    // Un pago en 0 con concepto sigue apareciendo tal cual (no es asesoría).
    await crearPago(tramiteId, "Ajuste", 0n, 3);

    const contexto = await contextoDeTramite(tramiteId);
    expect(contexto.costos.map(({ concepto, valor }) => ({ concepto, valor }))).toEqual([
      { concepto: "Registro VUCE", valor: 230_000n },
      { concepto: "Transferencia transporte", valor: 1_200_000n },
      { concepto: "Ajuste", valor: 0n },
      { concepto: "Transporte terrestre", valor: 1_000_000n },
    ]);
  });
});
