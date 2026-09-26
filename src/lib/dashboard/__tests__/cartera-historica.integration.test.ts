/**
 * Cartera histórica aparte (D0) contra la BD local (Postgres :5433).
 *
 * Datos propios (cliente de prueba, limpieza al final). F1-F3 las "emitió la
 * carga del histórico": su borrador lo facturó el usuario de las cargas.
 *   F1 histórica sin cobros, 100.000 a cargo
 *   F2 histórica sin cobros, 5.000 a favor
 *   F3 histórica, 50.000 a cargo con un abono de 10.000 (ya no es "sin cobros")
 *   F4 no histórica, 70.000 a cargo
 *   F5 NUEVA sobre un DO histórico (la facturó una persona en la plataforma),
 *      30.000 a cargo, sin cobros: es deuda real, NO cartera histórica
 *
 * Con la separación activa: vencida = F3 + F4 + F5 (150.000), saldo neto del
 * cliente = −40.000 − 70.000 − 30.000 = −140.000, histórica = F1 + F2
 * (2 facturas, 100.000 a cargo, 5.000 a favor, neto −95.000). Tolerancia 0 pesos.
 *
 * Se omite si DATABASE_URL no está definida o la BD no responde.
 */
import "dotenv/config";

import { AgenciaAduanas, CanalPago, Ciudad, DestinoPago, EstadoBorrador, Rol, TipoCliente, TipoPagoFactura } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLAVE_CARTERA_HISTORICA_APARTE,
  EMAIL_USUARIO_CARGA_HISTORICA,
  SQL_FACTURA_HISTORICA_SIN_COBROS,
  TITULO_CARTERA_HISTORICA,
  carteraHistoricaAparte,
  esFacturaHistoricaSinCobros,
  whereFacturaHistoricaSinCobros,
} from "@/lib/cartera/historica";
import { eliminarPagoFactura, registrarPagoFacturaAbono } from "@/lib/cartera/service";
import { prisma } from "@/lib/db/prisma";

import { getCarteraHistorica, getClientesConAlertaCartera, getDashboardData, getSaldosNetoPorCliente } from "../service";

const TEST_PREFIX = "vitest-cartera-historica";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3012;

type Fixture = { clienteId: string; userId: string; f1: string; f2: string; f3: string; f4: string; f5: string };

const CLAVE_UMBRAL_CARTERA_CLIENTE = "UMBRAL_ALERTA_CARTERA_CLIENTE";

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
/** Valor del parámetro antes del test (null = la fila no existía), para restaurarlo. */
let parametroOriginal: string | null | undefined;
let numero = 0;

async function setParametro(valor: string, clave = CLAVE_CARTERA_HISTORICA_APARTE) {
  await prisma.parametro.upsert({
    where: { clave },
    update: { valor },
    create: { clave, valor, descripcion: "test" },
  });
}

/**
 * Usuario de las cargas del histórico (quien facturó F1-F3). Se crea si falta y
 * no se borra al final: es un usuario fijo del sistema, no un dato de este test.
 */
async function usuarioCargaHistorica(): Promise<string> {
  const u = await prisma.user.upsert({
    where: { email: EMAIL_USUARIO_CARGA_HISTORICA },
    update: {},
    create: { email: EMAIL_USUARIO_CARGA_HISTORICA, name: "Importación histórico", rol: Rol.OPERATIVO, emailVerified: true },
  });
  return u.id;
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
  opts: { esHistorico: boolean; facturadoPorId: string; saldoACargo?: bigint; saldoAFavor?: bigint },
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
      facturadoPorId: opts.facturadoPorId,
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
      const deCarga = { esHistorico: true, facturadoPorId: await usuarioCargaHistorica() };
      const f1 = await crearFactura(cliente.id, user.id, { ...deCarga, saldoACargo: 100_000n });
      const f2 = await crearFactura(cliente.id, user.id, { ...deCarga, saldoAFavor: 5_000n });
      const f3 = await crearFactura(cliente.id, user.id, { ...deCarga, saldoACargo: 50_000n });
      await abonar(f3, 10_000n, user.id);
      const f4 = await crearFactura(cliente.id, user.id, { esHistorico: false, facturadoPorId: user.id, saldoACargo: 70_000n });
      // F5: factura NUEVA emitida en la plataforma sobre un DO histórico (la facturó una persona).
      const f5 = await crearFactura(cliente.id, user.id, { esHistorico: true, facturadoPorId: user.id, saldoACargo: 30_000n });
      fixture = { clienteId: cliente.id, userId: user.id, f1, f2, f3, f4, f5 };
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

    // NOT: { AND: [A, B, C] } = ¬(A ∧ B ∧ C): F3 (histórica con cobro), F4 (no histórica) y F5 (nueva
    // sobre un DO histórico) son corriente.
    const corrientePrisma = await prisma.factura.findMany({ where: { clienteId: db.clienteId, NOT: whereFacturaHistoricaSinCobros }, select: { id: true } });
    const corrienteSql = await prisma.$queryRaw<{ id: string }[]>`
      SELECT fa.id FROM factura fa WHERE fa."clienteId" = ${db.clienteId} AND NOT ${SQL_FACTURA_HISTORICA_SIN_COBROS}`;
    expect(new Set(corrientePrisma.map((f) => f.id))).toEqual(new Set([db.f3, db.f4, db.f5]));
    expect(new Set(corrienteSql.map((f) => f.id))).toEqual(new Set([db.f3, db.f4, db.f5]));
  });

  it("separación activa: vencida 150.000 (F3+F4+F5), neto −140.000, histórica 2 facturas / 100.000 / 5.000 / −95.000", async (ctx) => {
    const db = ensureDb(ctx);
    expect(await carteraHistoricaAparte()).toBe(true);

    const vencidas = await vencidasCliente(db.clienteId, true);
    expect(vencidas.ids).toEqual(new Set([db.f3, db.f4, db.f5]));
    expect(vencidas.total).toBe(150_000n);

    expect(await saldoNetoCliente(db.clienteId, true)).toBe(-140_000n);

    expect(await historicaCliente(db.clienteId)).toEqual({
      clienteId: db.clienteId,
      clienteNombre: `Cliente Vitest Histórica ${runId}`,
      facturas: 2,
      totalACargo: "100000",
      totalAFavor: "5000",
      saldoNeto: "-95000",
    });
  });

  it("el tablero aplica la separación: la vencida global suma F3, F4 y F5 y no F1; la sección trae el título", async (ctx) => {
    const db = ensureDb(ctx);
    const data = await getDashboardData();

    // Referencia global en memoria con la misma regla.
    const vencidasRef = await prisma.factura.findMany({
      where: { saldoACargoCliente: { gt: 0n }, fechaPagoCliente: null },
      select: {
        id: true,
        saldoACargoCliente: true,
        pagos: { select: { destino: true } },
        borrador: { select: { facturadoPor: { select: { email: true } }, tramite: { select: { esHistorico: true } } } },
      },
    });
    const corrientes = vencidasRef.filter(
      (f) =>
        !esFacturaHistoricaSinCobros({
          esHistorico: f.borrador.tramite.esHistorico,
          deCargaHistorica: f.borrador.facturadoPor?.email === EMAIL_USUARIO_CARGA_HISTORICA,
          pagos: f.pagos,
        }),
    );
    expect(data.cantidadFacturasVencidas).toBe(corrientes.length);
    expect(data.totalCarteraVencida).toBe(corrientes.reduce((s, f) => s + f.saldoACargoCliente, 0n).toString());
    expect(corrientes.some((f) => f.id === db.f1)).toBe(false);
    expect(corrientes.some((f) => f.id === db.f3)).toBe(true);
    // La factura nueva sobre un DO histórico cuenta en la vencida del tablero.
    expect(corrientes.some((f) => f.id === db.f5)).toBe(true);

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
      expect(vencidas.ids).toEqual(new Set([db.f1, db.f3, db.f4, db.f5]));
      expect(vencidas.total).toBe(250_000n);
      expect(await saldoNetoCliente(db.clienteId, true)).toBe(-239_999n);
      expect(await historicaCliente(db.clienteId)).toMatchObject({ facturas: 1, totalACargo: "0", totalAFavor: "5000", saldoNeto: "5000" });
    } finally {
      const r = await eliminarPagoFactura(pagoId, db.userId);
      expect(r.ok).toBe(true);
    }

    const vencidas = await vencidasCliente(db.clienteId, true);
    expect(vencidas.ids).toEqual(new Set([db.f3, db.f4, db.f5]));
    expect(await saldoNetoCliente(db.clienteId, true)).toBe(-140_000n);
    expect(await historicaCliente(db.clienteId)).toMatchObject({ facturas: 2, totalACargo: "100000", saldoNeto: "-95000" });
  });

  it("con CARTERA_HISTORICA_APARTE = NO todo vuelve a la cartera normal: vencida 250.000 (4 a cargo), neto −235.000, histórica inactiva", async (ctx) => {
    const db = ensureDb(ctx);
    await setParametro("NO");
    try {
      expect(await carteraHistoricaAparte()).toBe(false);

      const vencidas = await vencidasCliente(db.clienteId, false);
      expect(vencidas.ids).toEqual(new Set([db.f1, db.f3, db.f4, db.f5]));
      expect(vencidas.total).toBe(250_000n);
      // Sin `aparte` explícito, getSaldosNetoPorCliente lee el parámetro.
      const netos = await getSaldosNetoPorCliente();
      expect(netos.find((f) => f.clienteId === db.clienteId)?.saldoNeto).toBe(-235_000n);

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

  it("la factura nueva sobre un DO histórico dispara la alerta de cartera (umbral −120.000: el neto −140.000 alerta; sin F5 serían −110.000)", async (ctx) => {
    const db = ensureDb(ctx);
    const previo = await prisma.parametro.findUnique({ where: { clave: CLAVE_UMBRAL_CARTERA_CLIENTE } });
    await setParametro("-120000", CLAVE_UMBRAL_CARTERA_CLIENTE);
    try {
      const alertas = await getClientesConAlertaCartera(true);
      expect(alertas.find((a) => a.clienteId === db.clienteId)?.saldoNeto).toBe("-140000");

      const data = await getDashboardData();
      expect(data.alertasCartera.find((a) => a.clienteId === db.clienteId)?.saldoNeto).toBe("-140000");
    } finally {
      if (previo) await setParametro(previo.valor, CLAVE_UMBRAL_CARTERA_CLIENTE);
      else await prisma.parametro.deleteMany({ where: { clave: CLAVE_UMBRAL_CARTERA_CLIENTE } });
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
