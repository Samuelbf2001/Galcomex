/**
 * Cartera histórica aparte (D0) contra la BD local (Postgres :5433).
 *
 * Datos propios (cliente de prueba, limpieza al final):
 *   F1 histórica sin cobros, 100.000 a cargo
 *   F2 histórica sin cobros, 5.000 a favor
 *   F3 histórica, 50.000 a cargo con un abono de 10.000 (ya no es "sin cobros")
 *   F4 no histórica, 70.000 a cargo
 *
 * Con la separación activa: vencida = F3 + F4 (120.000), saldo neto del
 * cliente = −40.000 − 70.000 = −110.000, histórica = F1 + F2 (2 facturas,
 * 100.000 a cargo, 5.000 a favor, neto −95.000). Tolerancia 0 pesos.
 *
 * Se omite si DATABASE_URL no está definida o la BD no responde.
 */
import "dotenv/config";

import { AgenciaAduanas, CanalPago, Ciudad, DestinoPago, EstadoBorrador, Rol, TipoCliente, TipoPagoFactura } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLAVE_CARTERA_HISTORICA_APARTE,
  SQL_FACTURA_HISTORICA_SIN_COBROS,
  TITULO_CARTERA_HISTORICA,
  carteraHistoricaAparte,
  whereFacturaHistoricaSinCobros,
} from "@/lib/cartera/historica";
import { eliminarPagoFactura, registrarPagoFacturaAbono } from "@/lib/cartera/service";
import { prisma } from "@/lib/db/prisma";

import { getCarteraHistorica, getDashboardData, getSaldosNetoPorCliente } from "../service";

const TEST_PREFIX = "vitest-cartera-historica";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3012;

type Fixture = { clienteId: string; userId: string; f1: string; f2: string; f3: string; f4: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
/** Valor del parámetro antes del test (null = la fila no existía), para restaurarlo. */
let parametroOriginal: string | null | undefined;
let numero = 0;

async function setParametro(valor: string) {
  await prisma.parametro.upsert({
    where: { clave: CLAVE_CARTERA_HISTORICA_APARTE },
    update: { valor },
    create: { clave: CLAVE_CARTERA_HISTORICA_APARTE, valor, descripcion: "test" },
  });
}

async function restaurarParametro() {
  if (parametroOriginal === undefined) return;
  if (parametroOriginal === null) {
    await prisma.parametro.deleteMany({ where: { clave: CLAVE_CARTERA_HISTORICA_APARTE } });
  } else {
    await setParametro(parametroOriginal);
  }
}

async function cleanupTestData() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  const facturas = await prisma.factura.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const facturaIds = facturas.map((f) => f.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: userIds } }, { entidadId: { in: facturaIds } }] } });
  await prisma.pagoFactura.deleteMany({ where: { facturaId: { in: facturaIds } } });
  await prisma.factura.deleteMany({ where: { id: { in: facturaIds } } });
  await prisma.borradorFactura.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function crearFactura(
  clienteId: string,
  userId: string,
  opts: { esHistorico: boolean; saldoACargo?: bigint; saldoAFavor?: bigint },
): Promise<string> {
  numero += 1;
  const saldoACargo = opts.saldoACargo ?? 0n;
  const saldoAFavor = opts.saldoAFavor ?? 0n;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN12-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: userId,
      esHistorico: opts.esHistorico,
    },
  });
  const total = 1_000_000n + saldoACargo - saldoAFavor;
  const borrador = await prisma.borradorFactura.create({
    data: {
      tramiteId: tramite.id,
      comision: 0n,
      ivaComision: 0n,
      impuesto4x1000: 0n,
      costosBancarios: 0n,
      totalAnticipo: 1_000_000n,
      totalPagos: 0n,
      totalFactura: total,
      saldoAFavorCliente: saldoAFavor,
      saldoACargoCliente: saldoACargo,
      estado: EstadoBorrador.FACTURADO,
    },
  });
  const factura = await prisma.factura.create({
    data: {
      borradorId: borrador.id,
      clienteId,
      numSiigo: `TSTH-${runId.slice(-8)}-${numero}`,
      fecha: new Date(`${stateYear}-01-15T12:00:00Z`),
      totalFactura: total,
      saldoAFavorCliente: saldoAFavor,
      saldoACargoCliente: saldoACargo,
      saldoAFavorLM: 0n,
      saldoACargoLM: 0n,
    },
  });
  return factura.id;
}

async function abonar(facturaId: string, monto: bigint, userId: string): Promise<string> {
  const r = await registrarPagoFacturaAbono({
    facturaId,
    destino: DestinoPago.CLIENTE,
    tipo: TipoPagoFactura.ABONO,
    monto,
    fecha: new Date(`${stateYear}-02-01T12:00:00Z`),
    canalPago: CanalPago.PSE,
    usuarioId: userId,
  });
  if (!r.ok) throw new Error(r.message);
  return r.pago.id;
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local no disponible");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

/** Vencidas del cliente con el mismo where del tablero. */
async function vencidasCliente(clienteId: string, aparte: boolean) {
  const filas = await prisma.factura.findMany({
    where: {
      clienteId,
      saldoACargoCliente: { gt: 0n },
      fechaPagoCliente: null,
      ...(aparte ? { NOT: whereFacturaHistoricaSinCobros } : {}),
    },
    select: { id: true, saldoACargoCliente: true },
  });
  return { ids: new Set(filas.map((f) => f.id)), total: filas.reduce((s, f) => s + f.saldoACargoCliente, 0n) };
}

async function saldoNetoCliente(clienteId: string, aparte: boolean) {
  const filas = await getSaldosNetoPorCliente({ aparte });
  return filas.find((f) => f.clienteId === clienteId)?.saldoNeto;
}

async function historicaCliente(clienteId: string) {
  const r = await getCarteraHistorica(true);
  return r.porCliente.find((c) => c.clienteId === clienteId);
}

describe("cartera histórica aparte (Postgres local)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida; se omiten tests de integración con Postgres";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      const fila = await prisma.parametro.findUnique({ where: { clave: CLAVE_CARTERA_HISTORICA_APARTE } });
      parametroOriginal = fila ? fila.valor : null;
      await setParametro("SI");
      await cleanupTestData();
      const user = await prisma.user.create({
        data: { email: `${TEST_PREFIX}-${runId}@example.test`, emailVerified: true, name: "Vitest Cartera Histórica", rol: Rol.ADMIN },
      });
      const cliente = await prisma.cliente.create({
        data: { nombre: `Cliente Vitest Histórica ${runId}`, nit: `${TEST_PREFIX}-${runId}`, tipo: TipoCliente.PROPIO },
      });
      const f1 = await crearFactura(cliente.id, user.id, { esHistorico: true, saldoACargo: 100_000n });
      const f2 = await crearFactura(cliente.id, user.id, { esHistorico: true, saldoAFavor: 5_000n });
      const f3 = await crearFactura(cliente.id, user.id, { esHistorico: true, saldoACargo: 50_000n });
      await abonar(f3, 10_000n, user.id);
      const f4 = await crearFactura(cliente.id, user.id, { esHistorico: false, saldoACargo: 70_000n });
      fixture = { clienteId: cliente.id, userId: user.id, f1, f2, f3, f4 };
    } catch (error) {
      dbUnavailableReason = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) {
      await restaurarParametro();
      await cleanupTestData();
    }
    await prisma.$disconnect();
  });

  it("el where de Prisma y el SQL dan el mismo conjunto (y su complemento)", async (ctx) => {
    const db = ensureDb(ctx);

    const porPrisma = await prisma.factura.findMany({ where: { clienteId: db.clienteId, ...whereFacturaHistoricaSinCobros }, select: { id: true } });
    const porSql = await prisma.$queryRaw<{ id: string }[]>`
      SELECT fa.id FROM factura fa WHERE fa."clienteId" = ${db.clienteId} AND ${SQL_FACTURA_HISTORICA_SIN_COBROS}`;
    expect(new Set(porPrisma.map((f) => f.id))).toEqual(new Set([db.f1, db.f2]));
    expect(new Set(porSql.map((f) => f.id))).toEqual(new Set([db.f1, db.f2]));

    // NOT: { AND: [A, B] } = ¬(A ∧ B): F3 (histórica con cobro) y F4 (no histórica) son corriente.
    const corrientePrisma = await prisma.factura.findMany({ where: { clienteId: db.clienteId, NOT: whereFacturaHistoricaSinCobros }, select: { id: true } });
    const corrienteSql = await prisma.$queryRaw<{ id: string }[]>`
      SELECT fa.id FROM factura fa WHERE fa."clienteId" = ${db.clienteId} AND NOT ${SQL_FACTURA_HISTORICA_SIN_COBROS}`;
    expect(new Set(corrientePrisma.map((f) => f.id))).toEqual(new Set([db.f3, db.f4]));
    expect(new Set(corrienteSql.map((f) => f.id))).toEqual(new Set([db.f3, db.f4]));
  });

  it("separación activa: vencida 120.000 (F3+F4), neto −110.000, histórica 2 facturas / 100.000 / 5.000 / −95.000", async (ctx) => {
    const db = ensureDb(ctx);
    expect(await carteraHistoricaAparte()).toBe(true);

    const vencidas = await vencidasCliente(db.clienteId, true);
    expect(vencidas.ids).toEqual(new Set([db.f3, db.f4]));
    expect(vencidas.total).toBe(120_000n);

    expect(await saldoNetoCliente(db.clienteId, true)).toBe(-110_000n);

    expect(await historicaCliente(db.clienteId)).toEqual({
      clienteId: db.clienteId,
      clienteNombre: `Cliente Vitest Histórica ${runId}`,
      facturas: 2,
      totalACargo: "100000",
      totalAFavor: "5000",
      saldoNeto: "-95000",
    });
  });

  it("el tablero aplica la separación: la vencida global suma F3+F4 y no F1; la sección trae el título", async (ctx) => {
    const db = ensureDb(ctx);
    const data = await getDashboardData();

    // Referencia global en memoria con la misma regla.
    const vencidasRef = await prisma.factura.findMany({
      where: { saldoACargoCliente: { gt: 0n }, fechaPagoCliente: null },
      select: { id: true, saldoACargoCliente: true, pagos: { select: { destino: true } }, borrador: { select: { tramite: { select: { esHistorico: true } } } } },
    });
    const corrientes = vencidasRef.filter((f) => !(f.borrador.tramite.esHistorico && !f.pagos.some((p) => p.destino === DestinoPago.CLIENTE)));
    expect(data.cantidadFacturasVencidas).toBe(corrientes.length);
    expect(data.totalCarteraVencida).toBe(corrientes.reduce((s, f) => s + f.saldoACargoCliente, 0n).toString());
    expect(corrientes.some((f) => f.id === db.f1)).toBe(false);
    expect(corrientes.some((f) => f.id === db.f3)).toBe(true);

    expect(data.carteraHistorica.activa).toBe(true);
    expect(data.carteraHistorica.titulo).toBe(TITULO_CARTERA_HISTORICA);
    expect(data.carteraHistorica.porCliente.find((c) => c.clienteId === db.clienteId)?.saldoNeto).toBe("-95000");
    // Totales globales = Σ de las filas por cliente (BigInt).
    const suma = data.carteraHistorica.porCliente.reduce(
      (acc, c) => ({ aCargo: acc.aCargo + BigInt(c.totalACargo), aFavor: acc.aFavor + BigInt(c.totalAFavor), facturas: acc.facturas + c.facturas }),
      { aCargo: 0n, aFavor: 0n, facturas: 0 },
    );
    expect(data.carteraHistorica.totalACargo).toBe(suma.aCargo.toString());
    expect(data.carteraHistorica.totalAFavor).toBe(suma.aFavor.toString());
    expect(data.carteraHistorica.cantidadFacturas).toBe(suma.facturas);
  });

  it("abonar 1 peso a F1 la saca de la histórica y la pasa a la vencida; anularlo la devuelve", async (ctx) => {
    const db = ensureDb(ctx);

    const pagoId = await abonar(db.f1, 1n, db.userId);
    try {
      const vencidas = await vencidasCliente(db.clienteId, true);
      expect(vencidas.ids).toEqual(new Set([db.f1, db.f3, db.f4]));
      expect(vencidas.total).toBe(220_000n);
      expect(await saldoNetoCliente(db.clienteId, true)).toBe(-209_999n);
      expect(await historicaCliente(db.clienteId)).toMatchObject({ facturas: 1, totalACargo: "0", totalAFavor: "5000", saldoNeto: "5000" });
    } finally {
      const r = await eliminarPagoFactura(pagoId, db.userId);
      expect(r.ok).toBe(true);
    }

    const vencidas = await vencidasCliente(db.clienteId, true);
    expect(vencidas.ids).toEqual(new Set([db.f3, db.f4]));
    expect(await saldoNetoCliente(db.clienteId, true)).toBe(-110_000n);
    expect(await historicaCliente(db.clienteId)).toMatchObject({ facturas: 2, totalACargo: "100000", saldoNeto: "-95000" });
  });

  it("con CARTERA_HISTORICA_APARTE = NO todo vuelve a la cartera normal: vencida 220.000 (3 a cargo), neto −205.000, histórica inactiva", async (ctx) => {
    const db = ensureDb(ctx);
    await setParametro("NO");
    try {
      expect(await carteraHistoricaAparte()).toBe(false);

      const vencidas = await vencidasCliente(db.clienteId, false);
      expect(vencidas.ids).toEqual(new Set([db.f1, db.f3, db.f4]));
      expect(vencidas.total).toBe(220_000n);
      // Sin `aparte` explícito, getSaldosNetoPorCliente lee el parámetro.
      const netos = await getSaldosNetoPorCliente();
      expect(netos.find((f) => f.clienteId === db.clienteId)?.saldoNeto).toBe(-205_000n);

      const data = await getDashboardData();
      expect(data.carteraHistorica).toMatchObject({ activa: false, cantidadFacturas: 0, totalACargo: "0", totalAFavor: "0", porCliente: [] });
      const vencidasGlobal = await prisma.factura.aggregate({
        where: { saldoACargoCliente: { gt: 0n }, fechaPagoCliente: null },
        _sum: { saldoACargoCliente: true },
        _count: { id: true },
      });
      expect(data.cantidadFacturasVencidas).toBe(vencidasGlobal._count.id);
      expect(data.totalCarteraVencida).toBe((vencidasGlobal._sum.saldoACargoCliente ?? 0n).toString());
    } finally {
      await setParametro("SI");
    }
  });

  it("getCarteraHistorica(false) devuelve la sección inactiva en ceros", async () => {
    const r = await getCarteraHistorica(false);
    expect(r).toEqual({
      activa: false,
      titulo: TITULO_CARTERA_HISTORICA,
      cantidadFacturas: 0,
      cantidadACargo: 0,
      totalACargo: "0",
      totalAFavor: "0",
      porCliente: [],
    });
  });
});
