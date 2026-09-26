/**
 * Tests de integración — Tope del abono (decisión de Ernesto, 25-sep-2026,
 * «Tema 1 – A»): un abono no pasa de lo que se debe; el sobrante solo entra
 * como anticipo del cliente, confirmado, con recaudo y comprobante.
 *
 * Cubre los tres caminos de entrada (abono de la factura, cruce de saldos y
 * conciliar lote), anular el abono que dejó un anticipo y la concurrencia.
 *
 * Requiere PostgreSQL con DATABASE_URL definida; sin BD los tests se omiten.
 * Tolerancia 0 pesos.
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

import { listarAnticipos } from "@/lib/anticipos/service";
import { prisma } from "@/lib/db/prisma";
import {
  conciliarLoteFacturas,
  eliminarPagoFactura,
  getFacturaConPagos,
  registrarPagoFacturaAbono,
} from "../service";

const TEST_PREFIX = "vitest-tope-abono";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3021;
const COMPROBANTE = `tramites/${TEST_PREFIX}/comprobantes/transferencia.pdf`;

type Fixture = { clienteId: string; userId: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let numero = 0;

async function cleanupTestData() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  const facturas = await prisma.factura.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const facturaIds = facturas.map((f) => f.id);
  const anticipos = await prisma.anticipo.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const anticipoIds = anticipos.map((a) => a.id);
  const pagos = await prisma.pagoFactura.findMany({ where: { facturaId: { in: facturaIds } }, select: { id: true } });

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { entidadId: { in: [...tramiteIds, ...facturaIds, ...anticipoIds, ...pagos.map((p) => p.id)] } },
      ],
    },
  });
  // El anticipo que nació de un abono apunta a ese abono: va primero.
  await prisma.aplicacionAnticipo.deleteMany({ where: { anticipoId: { in: anticipoIds } } });
  await prisma.anticipo.deleteMany({ where: { id: { in: anticipoIds } } });
  await prisma.pagoFactura.deleteMany({ where: { facturaId: { in: facturaIds } } });
  await prisma.factura.deleteMany({ where: { id: { in: facturaIds } } });
  await prisma.borradorFactura.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function crearTramite(db: Fixture) {
  numero += 1;
  return prisma.tramiteDO.create({
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
}

/** Factura directa en BD (saltando el flujo del borrador), como en service.test.ts. */
async function crearFactura(
  db: Fixture,
  saldos: { aCargoCliente?: bigint; aFavorCliente?: bigint; aCargoLM?: bigint } = {},
) {
  const tramite = await crearTramite(db);
  const aCargoCliente = saldos.aCargoCliente ?? 0n;
  const aFavorCliente = saldos.aFavorCliente ?? 0n;
  const aCargoLM = saldos.aCargoLM ?? 0n;
  const borrador = await prisma.borradorFactura.create({
    data: {
      tramiteId: tramite.id,
      comision: 150_000n,
      ivaComision: 28_500n,
      impuesto4x1000: 0n,
      costosBancarios: 0n,
      totalAnticipo: 0n,
      totalPagos: 0n,
      totalFactura: aCargoCliente,
      saldoACargoCliente: aCargoCliente,
      saldoAFavorCliente: aFavorCliente,
      saldoACargoLM: aCargoLM,
      estado: EstadoBorrador.FACTURADO,
    },
  });
  const factura = await prisma.factura.create({
    data: {
      borradorId: borrador.id,
      clienteId: db.clienteId,
      numSiigo: `TOPE-${runId.slice(-6)}-${numero}`,
      fecha: new Date(`${stateYear}-01-15`),
      totalFactura: aCargoCliente,
      saldoACargoCliente: aCargoCliente,
      saldoAFavorCliente: aFavorCliente,
      saldoAFavorLM: 0n,
      saldoACargoLM: aCargoLM,
    },
  });
  return { factura, tramite };
}

function abonoCliente(facturaId: string, monto: bigint, extra: Partial<Parameters<typeof registrarPagoFacturaAbono>[0]> = {}) {
  return registrarPagoFacturaAbono({
    facturaId,
    destino: DestinoPago.CLIENTE,
    tipo: TipoPagoFactura.ABONO,
    monto,
    fecha: new Date(`${stateYear}-02-01T00:00:00.000Z`),
    tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
    comprobanteKey: COMPROBANTE,
    usuarioId: fixture!.userId,
    ...extra,
  });
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD Postgres no disponible para tests del tope del abono");
    throw new Error("Test omitido porque la BD no está disponible");
  }
  return fixture;
}

describe("tope del abono (integración con Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      const user = await prisma.user.create({
        data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest Tope Abono", rol: Rol.ADMIN },
      });
      const cliente = await prisma.cliente.create({
        data: { nombre: "Cliente Vitest Tope Abono", nit: `${TEST_PREFIX}-${runId}`, tipo: TipoCliente.PROPIO },
      });
      fixture = { clienteId: cliente.id, userId: user.id };
    } catch (error) {
      dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) await cleanupTestData();
    await prisma.$disconnect();
  });

  it("abono igual a lo que se debe: salda la factura y no crea anticipo", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 1_000_000n });

    const r = await abonoCliente(factura.id, 1_000_000n);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldoNeto).toBe(0n);
    expect(r.anticipoExcedente).toBeNull();
    expect(r.factura.fechaPagoCliente).not.toBeNull();
    expect(await prisma.anticipo.count({ where: { pagoFacturaOrigenId: r.pago.id } })).toBe(0);
  });

  it("abono mayor sin confirmar el sobrante → 422 ABONO_EXCEDE_SALDO y no se guarda nada", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 1_000_000n });

    const r = await abonoCliente(factura.id, 1_200_000n);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.codigo).toBe("ABONO_EXCEDE_SALDO");
    expect(r.detalles).toEqual({ pendiente: 1_000_000n, excedente: 200_000n, permiteAnticipo: true });
    expect(r.message).toContain("$1.200.000");
    expect(r.message).toContain("$1.000.000");
    expect(r.message).toContain("$200.000");
    expect(await prisma.pagoFactura.count({ where: { facturaId: factura.id } })).toBe(0);
    expect(await prisma.anticipo.count({ where: { clienteId: fixture!.clienteId, monto: 200_000n } })).toBe(0);
  });

  it("ejemplo de Ernesto: debe 1.000.000, llegan 1.200.000 → factura pagada + anticipo de 200.000", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 1_000_000n });
    const costo = (await prisma.matrizRecaudo.findUnique({ where: { tipoRecaudo: TipoRecaudo.BANCOLOMBIA } }))?.costoFijo ?? 0n;

    const r = await abonoCliente(factura.id, 1_200_000n, { excedenteComoAnticipo: true, verificadoBanco: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // La factura recibe solo lo que debía y queda saldada.
    expect(r.pago.monto).toBe(1_000_000n);
    expect(r.pago.costoBancario).toBe(costo);
    expect(r.saldoNeto).toBe(0n);
    expect(r.factura.fechaPagoCliente).not.toBeNull();
    const detalle = await getFacturaConPagos(factura.id);
    expect(detalle?.pendienteDevolucionCliente).toBe(0n);
    expect(detalle?.pendienteCobroCliente).toBe(0n);

    // El sobrante es un anticipo del cliente, sin aplicar, enlazado al abono.
    expect(r.anticipoExcedente?.monto).toBe(200_000n);
    const anticipo = await prisma.anticipo.findUniqueOrThrow({ where: { id: r.anticipoExcedente!.id } });
    expect(anticipo).toMatchObject({
      clienteId: fixture!.clienteId,
      monto: 200_000n,
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      // Una transferencia, un costo bancario: ya quedó en el abono.
      costoRecaudo: 0n,
      soporteKey: COMPROBANTE,
      verificadoBanco: true,
      pagoFacturaOrigenId: r.pago.id,
    });
    expect(anticipo.fecha.toISOString()).toBe(`${stateYear}-02-01T00:00:00.000Z`);

    // Entre los dos suman exactamente lo que entró.
    expect(r.pago.monto + anticipo.monto).toBe(1_200_000n);

    // Trazabilidad: el abono y el anticipo quedan en el historial.
    const auditPago = await prisma.auditLog.findFirstOrThrow({ where: { entidad: "PagoFactura", entidadId: r.pago.id } });
    expect(auditPago.despues).toMatchObject({
      montoRecibido: "1200000",
      monto: "1000000",
      excedenteComoAnticipo: "200000",
      anticipoExcedenteId: anticipo.id,
    });
    const auditAnticipo = await prisma.auditLog.findFirstOrThrow({ where: { entidad: "Anticipo", entidadId: anticipo.id } });
    expect(auditAnticipo.accion).toBe("CREATE_ANTICIPO");
    expect(auditAnticipo.despues).toMatchObject({ origen: { pagoFacturaId: r.pago.id, facturaId: factura.id } });

    // El módulo de anticipos lo muestra con su origen y disponible completo.
    const lista = await listarAnticipos({ clienteId: fixture!.clienteId });
    const enLista = lista.find((a) => a.id === anticipo.id);
    expect(enLista?.restante).toBe(200_000n);
    expect(enLista?.origenAbono).toEqual({ facturaId: factura.id, numSiigo: factura.numSiigo });
  });

  it("con sobrante: sin comprobante o pagado por canal de salida → 422 y nada guardado", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 500_000n });

    const sinComprobante = await abonoCliente(factura.id, 600_000n, { excedenteComoAnticipo: true, comprobanteKey: null });
    expect(sinComprobante.ok).toBe(false);
    if (!sinComprobante.ok) {
      expect(sinComprobante.status).toBe(422);
      expect(sinComprobante.message).toContain("comprobante");
    }

    const porCanal = await abonoCliente(factura.id, 600_000n, {
      excedenteComoAnticipo: true,
      tipoRecaudo: undefined,
      canalPago: CanalPago.PSE,
    });
    expect(porCanal.ok).toBe(false);
    if (!porCanal.ok) {
      expect(porCanal.status).toBe(422);
      expect(porCanal.message).toContain("recaudo");
    }

    expect(await prisma.pagoFactura.count({ where: { facturaId: factura.id } })).toBe(0);
  });

  it("factura sin nada por cobrar: ni el abono ni el sobrante entran por aquí", async (ctx) => {
    ensureDb(ctx);
    const saldada = await crearFactura(fixture!, { aCargoCliente: 300_000n });
    const ok = await abonoCliente(saldada.factura.id, 300_000n);
    expect(ok.ok).toBe(true);

    const r = await abonoCliente(saldada.factura.id, 50_000n, { excedenteComoAnticipo: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("ABONO_EXCEDE_SALDO");
    expect(r.detalles).toMatchObject({ pendiente: 0n, permiteAnticipo: false });
    expect(r.message).toContain("Anticipos");

    // Factura con saldo a favor del cliente (Galcomex le debe): tampoco.
    const aFavor = await crearFactura(fixture!, { aFavorCliente: 3_357_958n });
    const r2 = await abonoCliente(aFavor.factura.id, 10_000n, { excedenteComoAnticipo: true });
    expect(r2.ok).toBe(false);
    expect(await prisma.pagoFactura.count({ where: { facturaId: aFavor.factura.id } })).toBe(0);
  });

  it("destino LM: el tope aplica y el sobrante no puede ser anticipo", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoLM: 400_000n });

    const r = await registrarPagoFacturaAbono({
      facturaId: factura.id,
      destino: DestinoPago.LM,
      tipo: TipoPagoFactura.ABONO,
      monto: 450_000n,
      fecha: new Date(`${stateYear}-02-01T00:00:00.000Z`),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      comprobanteKey: COMPROBANTE,
      excedenteComoAnticipo: true,
      usuarioId: fixture!.userId,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.detalles).toMatchObject({ pendiente: 400_000n, excedente: 50_000n, permiteAnticipo: false });
    expect(await prisma.pagoFactura.count({ where: { facturaId: factura.id } })).toBe(0);

    const exacto = await registrarPagoFacturaAbono({
      facturaId: factura.id,
      destino: DestinoPago.LM,
      tipo: TipoPagoFactura.ABONO,
      monto: 400_000n,
      fecha: new Date(`${stateYear}-02-01T00:00:00.000Z`),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      usuarioId: fixture!.userId,
    });
    expect(exacto.ok).toBe(true);
    if (exacto.ok) expect(exacto.saldoNeto).toBe(0n);
  });

  it("abono por cruce de saldos: el tope aplica, sin anticipo", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 700_000n });

    const r = await registrarPagoFacturaAbono({
      facturaId: factura.id,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto: 800_000n,
      fecha: new Date(`${stateYear}-02-01T00:00:00.000Z`),
      compensacionId: `${runId}-cruce`,
      excedenteComoAnticipo: true,
      usuarioId: fixture!.userId,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detalles).toMatchObject({ permiteAnticipo: false });
    expect(await prisma.pagoFactura.count({ where: { facturaId: factura.id } })).toBe(0);
  });

  it("conciliar lote: el ítem que se pasa falla con su mensaje; los demás entran", async (ctx) => {
    ensureDb(ctx);
    const a = await crearFactura(fixture!, { aCargoCliente: 100_000n });
    const b = await crearFactura(fixture!, { aCargoCliente: 200_000n });
    const fecha = new Date(`${stateYear}-03-01T00:00:00.000Z`);

    const lote = await conciliarLoteFacturas({
      items: [
        { facturaId: a.factura.id, destino: DestinoPago.CLIENTE, tipo: TipoPagoFactura.ABONO, monto: 100_000n, fecha, tipoRecaudo: TipoRecaudo.BANCOLOMBIA },
        { facturaId: b.factura.id, destino: DestinoPago.CLIENTE, tipo: TipoPagoFactura.ABONO, monto: 250_000n, fecha, tipoRecaudo: TipoRecaudo.BANCOLOMBIA },
      ],
      usuarioId: fixture!.userId,
    });

    expect(lote.ok).toBe(1);
    expect(lote.failed).toBe(1);
    const fallo = lote.results.find((x) => x.facturaId === b.factura.id);
    expect(fallo?.ok).toBe(false);
    if (fallo && !fallo.ok) {
      expect(fallo.status).toBe(422);
      expect(fallo.error).toContain("desde la factura");
    }
    expect(await prisma.pagoFactura.count({ where: { facturaId: b.factura.id } })).toBe(0);
  });

  it("anular el abono retira también el anticipo que dejó (si no se ha usado)", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 1_000_000n });
    const r = await abonoCliente(factura.id, 1_200_000n, { excedenteComoAnticipo: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const anticipoId = r.anticipoExcedente!.id;

    const anulado = await eliminarPagoFactura(r.pago.id, fixture!.userId);

    expect(anulado.ok).toBe(true);
    if (!anulado.ok) return;
    expect(anulado.saldoNeto).toBe(-1_000_000n);
    expect(anulado.anticipoEliminadoId).toBe(anticipoId);
    expect(await prisma.anticipo.findUnique({ where: { id: anticipoId } })).toBeNull();
    expect(await prisma.pagoFactura.findUnique({ where: { id: r.pago.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entidad: "Anticipo", entidadId: anticipoId, accion: "ELIMINAR_ANTICIPO_EXCEDENTE" } });
    expect(audit.antes).toMatchObject({ monto: "200000", pagoFacturaOrigenId: r.pago.id });
  });

  it("si el anticipo del sobrante ya se aplicó a un DO, no deja anular el abono", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 1_000_000n });
    const r = await abonoCliente(factura.id, 1_300_000n, { excedenteComoAnticipo: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const otroDo = await crearTramite(fixture!);
    await prisma.aplicacionAnticipo.create({
      data: { anticipoId: r.anticipoExcedente!.id, tramiteId: otroDo.id, montoAplicado: 300_000n },
    });

    const anulado = await eliminarPagoFactura(r.pago.id, fixture!.userId);

    expect(anulado.ok).toBe(false);
    if (anulado.ok) return;
    expect(anulado.status).toBe(422);
    expect(anulado.message).toContain(otroDo.consecutivo);
    expect(await prisma.pagoFactura.findUnique({ where: { id: r.pago.id } })).not.toBeNull();
    expect(await prisma.anticipo.findUnique({ where: { id: r.anticipoExcedente!.id } })).not.toBeNull();
  });

  it("dos abonos de más a la vez sobre la misma factura: solo uno toma el saldo", async (ctx) => {
    ensureDb(ctx);
    const { factura } = await crearFactura(fixture!, { aCargoCliente: 1_000_000n });

    const [x, y] = await Promise.all([
      abonoCliente(factura.id, 1_100_000n, { excedenteComoAnticipo: true }),
      abonoCliente(factura.id, 1_100_000n, { excedenteComoAnticipo: true }),
    ]);

    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const pagos = await prisma.pagoFactura.findMany({ where: { facturaId: factura.id } });
    expect(pagos).toHaveLength(1);
    expect(pagos[0].monto).toBe(1_000_000n);
    expect(await prisma.anticipo.count({ where: { pagoFacturaOrigenId: pagos[0].id } })).toBe(1);
  });
});
