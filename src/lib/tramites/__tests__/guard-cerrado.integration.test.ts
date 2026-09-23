/**
 * Tests de integración — Guard transversal de trámite CERRADO (A?? — bloqueo
 * total al cerrar el trámite, reunión 1-jul).
 *
 * Cubre el mínimo pedido:
 *  - pago (crear/actualizar/eliminar) rechazado en trámite CERRADO
 *  - aplicar/eliminar anticipo rechazado en trámite CERRADO
 *  - documento (registrar/eliminar/reemplazar) rechazado en trámite CERRADO
 *  - edición de borrador (línea manual) rechazada en trámite CERRADO
 *  - pago multi-DO rechazado si UNO de los DOs del grupo está CERRADO
 *  - reapertura de un trámite CERRADO: ADMIN puede, REVISOR no (403)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida. Si la BD no
 * está disponible, todos los tests se omiten (skip).
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  CanalPago,
  CategoriaDocumento,
  Ciudad,
  EstadoTramite,
  Rol,
  TipoCliente,
  TipoRecaudo,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Evita que eliminarDocumento/reemplazarDocumento fallen al intentar hablar
// con MinIO (no disponible en el entorno de tests) — mismo patrón que
// src/lib/documentos/__tests__/service.test.ts.
vi.mock("@/lib/storage/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage/service")>();
  return {
    ...original,
    createPresignedDownloadUrl: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
    softDeleteStorageObject: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
    createPresignedUploadUrl: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
  };
});

import { aplicarAnticipo, eliminarAplicacion } from "@/lib/anticipos/service";
import { crearLineaManual } from "@/lib/borradores/lineas-service";
import { prisma } from "@/lib/db/prisma";
import {
  eliminarDocumento,
  registrarDocumento,
  reemplazarDocumento,
} from "@/lib/documentos/service";
import {
  actualizarPago,
  crearPago,
  crearPagoMultiDO,
  eliminarPago,
} from "@/lib/pagos/service";
import { transitionTramite } from "@/lib/tramites/service";
import { TramiteCerradoError } from "../guard";

// ─── Constantes del test ─────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-guard-cerrado";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3003;

type Fixture = {
  clienteId: string;
  adminId: string;
  revisorId: string;
};

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let numeroSeq = 0;

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

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
      ],
    },
  });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.lineaRevisionFactura.deleteMany({
    where: { linea: { borrador: { tramiteId: { in: tramiteIds } } } },
  });
  await prisma.lineaRevision.deleteMany({ where: { borrador: { tramiteId: { in: tramiteIds } } } });
  await prisma.borradorFactura.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pagoTramiteFactura.deleteMany({ where: { pago: { tramiteId: { in: tramiteIds } } } });
  await prisma.pagoTramiteBeneficiario.deleteMany({ where: { pago: { tramiteId: { in: tramiteIds } } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });

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
  await prisma.beneficiario.deleteMany({ where: { nit: { startsWith: TEST_PREFIX } } });
}

async function createFixture(): Promise<Fixture> {
  const admin = await prisma.user.create({
    data: {
      email: `${runId}-admin@example.test`,
      emailVerified: true,
      name: "Vitest Guard Cerrado ADMIN",
      rol: Rol.ADMIN,
    },
  });
  const revisor = await prisma.user.create({
    data: {
      email: `${runId}-revisor@example.test`,
      emailVerified: true,
      name: "Vitest Guard Cerrado REVISOR",
      rol: Rol.REVISOR,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Guard Cerrado",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
      // Este archivo prueba el guard transversal de CERRADO (pagos, anticipos,
      // documentos, reapertura ADMIN/REVISOR), no D1/D2 — se apagan para no
      // arrastrar el fixture de tarifa vigente + BL/factura de
      // `requisitos.integration.test.ts` (que sí las ejercita a propósito,
      // incluso durante la reapertura, F4).
      capacidades: {
        create: [
          { codigo: "do_exige_tarifa_vigente", habilitado: false },
          { codigo: "docs_bl_factura_obligatorios", habilitado: false },
        ],
      },
    },
  });

  return { clienteId: cliente.id, adminId: admin.id, revisorId: revisor.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests del guard");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

/** Crea un TramiteDO directo en BD, en el estado indicado (SOLICITUD por defecto). */
async function crearTramiteTest(
  db: Fixture,
  estado: EstadoTramite = EstadoTramite.SOLICITUD,
): Promise<{ id: string; consecutivo: string }> {
  numeroSeq += 1;
  const numero = numeroSeq;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId: db.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.adminId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado,
    },
  });
  return { id: tramite.id, consecutivo: tramite.consecutivo };
}

async function cerrarTramite(tramiteId: string): Promise<void> {
  await prisma.tramiteDO.update({ where: { id: tramiteId }, data: { estado: EstadoTramite.CERRADO } });
}

async function aplicarAnticipoDirecto(db: Fixture, tramiteId: string, monto: bigint): Promise<string> {
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: db.clienteId,
      monto,
      fecha: new Date("3003-01-10"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 1_950n,
      verificadoBanco: true,
    },
  });
  const aplicacion = await prisma.aplicacionAnticipo.create({
    data: { anticipoId: anticipo.id, tramiteId, montoAplicado: monto },
  });
  return aplicacion.id;
}

async function crearBeneficiarioTest(nombre: string): Promise<string> {
  const b = await prisma.beneficiario.create({
    data: { nombre, nit: `${TEST_PREFIX}-${runId}-${Math.random().toString(36).slice(2)}` },
  });
  return b.id;
}

async function crearFacturaProveedorTest(
  db: Fixture,
  tramiteId: string,
  numFactura: string,
  valor: bigint,
  beneficiarioId: string,
): Promise<string> {
  const fp = await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "Proveedor Vitest",
      beneficiarioId,
      numFactura,
      valor,
      fecha: new Date("3003-02-01"),
      subidaPorId: db.adminId,
    },
  });
  return fp.id;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("guard transversal de trámite CERRADO", () => {
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
    if (dbConnected) {
      await cleanupTestData();
    }
    await prisma.$disconnect();
  });

  // ─── Pagos ───────────────────────────────────────────────────────────────

  it("crearPago se rechaza en un trámite CERRADO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db);
    await aplicarAnticipoDirecto(db, tramite.id, 5_000_000n);
    await cerrarTramite(tramite.id);

    await expect(
      crearPago({
        tramiteId: tramite.id,
        concepto: "Pago en tramite cerrado",
        valor: 1_000_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.adminId,
      }),
    ).rejects.toThrow(TramiteCerradoError);

    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId: tramite.id } });
    expect(pagos).toHaveLength(0);
  });

  it("actualizarPago y eliminarPago se rechazan cuando el trámite pasa a CERRADO después de creado el pago", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db);
    await aplicarAnticipoDirecto(db, tramite.id, 5_000_000n);

    const pago = await crearPago({
      tramiteId: tramite.id,
      concepto: "Pago antes de cerrar",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.adminId,
    });

    await cerrarTramite(tramite.id);

    await expect(
      actualizarPago(pago.id, { valor: 2_000_000n }, db.adminId),
    ).rejects.toThrow(TramiteCerradoError);

    await expect(eliminarPago(pago.id, db.adminId)).rejects.toThrow(TramiteCerradoError);

    const persisted = await prisma.pagoTramite.findUnique({ where: { id: pago.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.valor).toBe(1_000_000n);
  });

  // ─── Anticipos ───────────────────────────────────────────────────────────

  it("aplicarAnticipo se rechaza en un trámite CERRADO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db, EstadoTramite.CERRADO);

    const anticipo = await prisma.anticipo.create({
      data: {
        clienteId: db.clienteId,
        monto: 3_000_000n,
        fecha: new Date("3003-01-15"),
        tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
        costoRecaudo: 1_950n,
        verificadoBanco: true,
      },
    });

    await expect(
      aplicarAnticipo(
        { anticipoId: anticipo.id, tramiteId: tramite.id, montoAplicado: 1_000_000n },
        db.adminId,
      ),
    ).rejects.toThrow(TramiteCerradoError);

    const aplicaciones = await prisma.aplicacionAnticipo.findMany({ where: { tramiteId: tramite.id } });
    expect(aplicaciones).toHaveLength(0);
  });

  it("eliminarAplicacion se rechaza cuando el trámite pasa a CERRADO después de aplicado el anticipo", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db);
    const aplicacionId = await aplicarAnticipoDirecto(db, tramite.id, 2_000_000n);

    await cerrarTramite(tramite.id);

    await expect(eliminarAplicacion(aplicacionId, db.adminId)).rejects.toThrow(TramiteCerradoError);

    const persisted = await prisma.aplicacionAnticipo.findUnique({ where: { id: aplicacionId } });
    expect(persisted).not.toBeNull();
  });

  // ─── Documentos ──────────────────────────────────────────────────────────

  it("registrarDocumento se rechaza en un trámite CERRADO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db, EstadoTramite.CERRADO);

    await expect(
      registrarDocumento({
        tramiteId: tramite.id,
        categoria: CategoriaDocumento.OTRO,
        nombreArchivo: "archivo.pdf",
        storageKey: `vitest/${runId}/archivo.pdf`,
        mimeType: "application/pdf",
        tamanoBytes: 1024,
        subidoPorId: db.adminId,
      }),
    ).rejects.toThrow(TramiteCerradoError);

    const documentos = await prisma.documento.findMany({ where: { tramiteId: tramite.id } });
    expect(documentos).toHaveLength(0);
  });

  it("eliminarDocumento y reemplazarDocumento se rechazan cuando el trámite pasa a CERRADO después de subido el documento", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db);

    const doc = await prisma.documento.create({
      data: {
        tramiteId: tramite.id,
        categoria: CategoriaDocumento.OTRO,
        nombreArchivo: "antes-de-cerrar.pdf",
        storageKey: `vitest/${runId}/antes-de-cerrar.pdf`,
        mimeType: "application/pdf",
        tamanoBytes: 2048,
        subidoPorId: db.adminId,
      },
    });

    await cerrarTramite(tramite.id);

    await expect(eliminarDocumento(doc.id, db.adminId, Rol.ADMIN)).rejects.toThrow(TramiteCerradoError);

    await expect(
      reemplazarDocumento({
        documentoId: doc.id,
        usuarioId: db.adminId,
        rol: Rol.ADMIN,
        storageKey: `vitest/${runId}/reemplazo.pdf`,
        nombreArchivo: "reemplazo.pdf",
        mimeType: "application/pdf",
        tamanoBytes: 4096,
      }),
    ).rejects.toThrow(TramiteCerradoError);

    const persisted = await prisma.documento.findUnique({ where: { id: doc.id } });
    expect(persisted?.eliminado).toBe(false);
    expect(persisted?.nombreArchivo).toBe("antes-de-cerrar.pdf");
  });

  // ─── Borrador (edición de líneas) ────────────────────────────────────────

  it("crearLineaManual (edición de borrador) se rechaza cuando el trámite del borrador está CERRADO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db);

    const borrador = await prisma.borradorFactura.create({
      data: {
        tramiteId: tramite.id,
        comision: 0n,
        ivaComision: 0n,
        impuesto4x1000: 0n,
        costosBancarios: 0n,
        totalAnticipo: 0n,
        totalPagos: 0n,
        totalFactura: 0n,
      },
    });

    await cerrarTramite(tramite.id);

    await expect(
      crearLineaManual({
        borradorId: borrador.id,
        concepto: "Línea manual en trámite cerrado",
        valor: 100_000n,
        usuarioId: db.adminId,
      }),
    ).rejects.toThrow(TramiteCerradoError);

    const lineas = await prisma.lineaRevision.findMany({ where: { borradorId: borrador.id } });
    expect(lineas).toHaveLength(0);
  });

  // ─── Pago multi-DO ───────────────────────────────────────────────────────

  it("crearPagoMultiDO se rechaza por completo si UNO de los DOs del grupo está CERRADO", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario Guard Cerrado MultiDO");

    const tramiteAbierto = await crearTramiteTest(db);
    const tramiteCerrado = await crearTramiteTest(db, EstadoTramite.CERRADO);
    await aplicarAnticipoDirecto(db, tramiteAbierto.id, 5_000_000n);

    const fp1 = await crearFacturaProveedorTest(db, tramiteAbierto.id, "FP-GUARD-001", 1_000_000n, beneficiarioId);
    const fp2 = await crearFacturaProveedorTest(db, tramiteCerrado.id, "FP-GUARD-002", 1_000_000n, beneficiarioId);

    await expect(
      crearPagoMultiDO({
        beneficiarioId,
        facturas: [
          { facturaProveedorId: fp1, monto: 1_000_000n },
          { facturaProveedorId: fp2, monto: 1_000_000n },
        ],
        canalPago: CanalPago.PSE,
        usuarioId: db.adminId,
      }),
    ).rejects.toThrow(TramiteCerradoError);

    // Transacción completa revertida: ningún pago creado en ninguno de los 2 DOs.
    const pagosAbierto = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteAbierto.id } });
    const pagosCerrado = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteCerrado.id } });
    expect(pagosAbierto).toHaveLength(0);
    expect(pagosCerrado).toHaveLength(0);
  });

  // ─── Reapertura (transitionTramite) ─────────────────────────────────────

  it("transitionTramite: un ADMIN puede reabrir un trámite CERRADO (con AuditLog REAPERTURA)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db, EstadoTramite.CERRADO);

    const result = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      db.adminId,
      false,
      Rol.ADMIN,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tramite.estado).toBe(EstadoTramite.EN_TRAMITE);
    }

    const persisted = await prisma.tramiteDO.findUnique({ where: { id: tramite.id } });
    expect(persisted?.estado).toBe(EstadoTramite.EN_TRAMITE);

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: tramite.id, accion: "REAPERTURA" },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog?.usuarioId).toBe(db.adminId);
  });

  it("transitionTramite: un REVISOR NO puede reabrir un trámite CERRADO (403)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearTramiteTest(db, EstadoTramite.CERRADO);

    const result = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      db.revisorId,
      false,
      Rol.REVISOR,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }

    const persisted = await prisma.tramiteDO.findUnique({ where: { id: tramite.id } });
    expect(persisted?.estado).toBe(EstadoTramite.CERRADO);

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: tramite.id, accion: "REAPERTURA" },
    });
    expect(auditLog).toBeNull();
  });
});
