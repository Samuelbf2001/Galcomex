/**
 * Tests de integración — Líneas manuales del borrador (flujo del socio).
 *
 * Requiere PostgreSQL local con DATABASE_URL definida. Si no está, se omiten (skip).
 * TEST_PREFIX único: "vitest-lineas". Año de datos de prueba: 3009.
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Rol,
  TipoCliente,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { generarBorrador, transicionarBorrador } from "../service";
import {
  BorradorNoEditableError,
  FacturaDeOtroTramiteError,
  actualizarLinea,
  crearLineaManual,
  eliminarLinea,
} from "../lineas-service";

const TEST_PREFIX = "vitest-lineas";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3009;

type Fixture = {
  clienteSocioId: string;
  clientePropioId: string;
  userId: string;
};

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let tramiteCounter = 0;

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
  // lineaRevision borra el pivot linea_revision_factura en cascada.
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  // pagoTramite borra el pivot pago_tramite_factura en cascada.
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  // Ahora sí se pueden borrar las facturas de proveedor (sin pivots que las restrinjan).
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });

  const testAnticipos = await prisma.anticipo.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const anticipoIds = testAnticipos.map((a) => a.id);
  await prisma.aplicacionAnticipo.deleteMany({ where: { anticipoId: { in: anticipoIds } } });
  await prisma.anticipo.deleteMany({ where: { id: { in: anticipoIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-admin-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Lineas Admin",
      rol: Rol.ADMIN,
    },
  });
  const clienteSocio = await prisma.cliente.create({
    data: {
      nombre: "Cliente Socio LM",
      nit: `${TEST_PREFIX}-socio-${runId}`,
      tipo: TipoCliente.SOCIO_LM,
    },
  });
  const clientePropio = await prisma.cliente.create({
    data: {
      nombre: "Cliente Propio",
      nit: `${TEST_PREFIX}-propio-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });
  return {
    clienteSocioId: clienteSocio.id,
    clientePropioId: clientePropio.id,
    userId: user.id,
  };
}

async function crearTramite(db: Fixture, clienteId: string): Promise<string> {
  tramiteCounter++;
  const numero = tramiteCounter;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.userId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
    },
  });
  return tramite.id;
}

async function crearFacturaProveedor(
  db: Fixture,
  tramiteId: string,
  numFactura: string,
  valor: bigint,
): Promise<string> {
  const fp = await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "Proveedor Test",
      numFactura,
      valor,
      fecha: new Date(`${stateYear}-02-01`),
      subidaPorId: db.userId,
    },
  });
  return fp.id;
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de líneas");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

describe("lineas-service con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida; se omiten tests de integración";
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

  it("SOCIO_LM: crear línea manual con facturas vinculadas promueve el total y crea el pivot", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramite(db, db.clienteSocioId);
    const borrador = await generarBorrador({
      tramiteId,
      comision: 0n,
      ivaComision: 0n,
      usuarioId: db.userId,
    });
    expect(borrador?.totalFactura).toBe(0n);

    const fp1 = await crearFacturaProveedor(db, tramiteId, `FL-${runId}-1`, 1_000_000n);
    const fp2 = await crearFacturaProveedor(db, tramiteId, `FL-${runId}-2`, 500_000n);

    const actualizado = await crearLineaManual({
      borradorId: borrador!.id,
      concepto: "Pago terceros LUTOSA",
      valor: 1_500_000n,
      facturaIds: [fp1, fp2],
      usuarioId: db.userId,
    });

    expect(actualizado?.lineasRevision).toHaveLength(1);
    const linea = actualizado!.lineasRevision[0]!;
    expect(linea.origen).toBe("MANUAL");
    // El total se promueve a totalFactura en SOCIO_LM: Σlíneas + 0 + 0 − 0
    expect(actualizado!.totalFacturaLineas).toBe(1_500_000n);
    expect(actualizado!.totalFactura).toBe(1_500_000n);

    // Pivot creado con ambas facturas
    const pivots = await prisma.lineaRevisionFactura.findMany({ where: { lineaId: linea.id } });
    expect(pivots.map((p) => p.facturaId).sort()).toEqual([fp1, fp2].sort());

    // AuditLog registrado
    const logs = await prisma.auditLog.findMany({
      where: { entidad: "LineaRevision", entidadId: linea.id, accion: "CREATE" },
    });
    expect(logs.length).toBe(1);
  });

  it("PROPIO: la línea manual actualiza totalFacturaLineas pero NO promueve totalFactura", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramite(db, db.clientePropioId);
    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      ivaComision: 28_500n,
      usuarioId: db.userId,
    });
    const totalMotor = borrador!.totalFactura;

    const actualizado = await crearLineaManual({
      borradorId: borrador!.id,
      concepto: "Ítem extra",
      valor: 2_000_000n,
      usuarioId: db.userId,
    });

    // totalFactura del motor se preserva en PROPIO
    expect(actualizado!.totalFactura).toBe(totalMotor);
    // totalFacturaLineas refleja Σlíneas + comisión + IVA − retenciones
    expect(actualizado!.totalFacturaLineas).toBe(2_000_000n + 150_000n + 28_500n);
  });

  it("rechaza vincular una factura de otro trámite", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteA = await crearTramite(db, db.clienteSocioId);
    const tramiteB = await crearTramite(db, db.clienteSocioId);
    const borradorA = await generarBorrador({
      tramiteId: tramiteA,
      comision: 0n,
      ivaComision: 0n,
      usuarioId: db.userId,
    });
    const fpB = await crearFacturaProveedor(db, tramiteB, `FL-${runId}-otro`, 100_000n);

    await expect(
      crearLineaManual({
        borradorId: borradorA!.id,
        concepto: "Línea inválida",
        valor: 100_000n,
        facturaIds: [fpB],
        usuarioId: db.userId,
      }),
    ).rejects.toBeInstanceOf(FacturaDeOtroTramiteError);
  });

  it("no permite editar líneas si el borrador está APROBADO → 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramite(db, db.clienteSocioId);
    const borrador = await generarBorrador({
      tramiteId,
      comision: 0n,
      ivaComision: 0n,
      usuarioId: db.userId,
    });
    const actualizado = await crearLineaManual({
      borradorId: borrador!.id,
      concepto: "Línea base",
      valor: 1_000_000n,
      usuarioId: db.userId,
    });
    const lineaId = actualizado!.lineasRevision[0]!.id;

    await transicionarBorrador({
      borradorId: borrador!.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });
    await transicionarBorrador({
      borradorId: borrador!.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userId,
    });

    await expect(
      actualizarLinea({ lineaId, valor: 9_999n, usuarioId: db.userId }),
    ).rejects.toBeInstanceOf(BorradorNoEditableError);
  });

  it("eliminar línea borra el pivot; no se puede borrar una factura vinculada (Restrict)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramite(db, db.clienteSocioId);
    const borrador = await generarBorrador({
      tramiteId,
      comision: 0n,
      ivaComision: 0n,
      usuarioId: db.userId,
    });
    const fp = await crearFacturaProveedor(db, tramiteId, `FL-${runId}-del`, 300_000n);
    const actualizado = await crearLineaManual({
      borradorId: borrador!.id,
      concepto: "Línea con factura",
      valor: 300_000n,
      facturaIds: [fp],
      usuarioId: db.userId,
    });
    const lineaId = actualizado!.lineasRevision[0]!.id;

    // Mientras la línea exista, la factura está restringida (pivot Restrict).
    await expect(prisma.facturaProveedor.delete({ where: { id: fp } })).rejects.toThrow();

    // Eliminar la línea borra el pivot en cascada.
    const tras = await eliminarLinea(lineaId, db.userId);
    expect(tras!.lineasRevision).toHaveLength(0);
    const pivots = await prisma.lineaRevisionFactura.findMany({ where: { lineaId } });
    expect(pivots).toHaveLength(0);

    // Ahora la factura ya se puede borrar.
    await prisma.facturaProveedor.delete({ where: { id: fp } });
  });
});
