/**
 * Tests de integración de la capa de persistencia del módulo Documentos.
 *
 * Estrategia de aislamiento de MinIO:
 * - solicitarSubida() llama a createPresignedUploadUrl (MinIO) → NO se testea aquí.
 * - listarDocumentos() llama a createPresignedDownloadUrl (MinIO) → el servicio
 *   captura el error si MinIO no está disponible y devuelve downloadUrl="".
 *   El test verifica que el documento aparece en la lista aunque la URL esté vacía.
 * - eliminarDocumento() llama a softDeleteStorageObject (MinIO) → el servicio
 *   también captura el error y no revierte el soft-delete de BD.
 *   El test verifica el soft-delete en BD directamente, sin MinIO.
 *
 * Resultado: los 3 tests (registrar, listar, eliminar) son puramente de BD.
 */

import "dotenv/config";

import { CategoriaDocumento, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/prisma";

// ─── Mock de storage ANTES de importar el servicio ───────────────────────────
// Evita que listarDocumentos y eliminarDocumento fallen si MinIO no está disponible.
vi.mock("@/lib/storage/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage/service")>();
  return {
    ...original,
    // createPresignedDownloadUrl: simular que MinIO no está disponible → lanza error
    // El servicio lo captura y devuelve downloadUrl=""
    createPresignedDownloadUrl: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
    // softDeleteStorageObject: simular que no hace nada (el servicio lo captura)
    softDeleteStorageObject: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
    // createPresignedUploadUrl: no se usa en estos tests
    createPresignedUploadUrl: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
  };
});

// Importar el servicio DESPUÉS del mock
import {
  eliminarDocumento,
  listarDocumentos,
  registrarDocumento,
} from "../service";

// ─── Constantes del test ──────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-documentos";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Fixture = {
  tramiteId: string;
  userId: string;
};

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

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
      ],
    },
    select: { id: true },
  });
  const tramiteIds = testTramites.map((t) => t.id);

  // Eliminar en orden de dependencias
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
      ],
    },
  });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Documentos",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Documentos",
      nit: `${runId}-nit`,
      tipo: TipoCliente.PROPIO,
    },
  });

  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ05-${runId.slice(-4)}`,
      ciudad: "BAQ",
      anio: 3005,
      numero: Math.floor(Math.random() * 9000) + 1000,
      clienteId: cliente.id,
      agenciaAduanas: "COLDEX",
      creadoPorId: user.id,
    },
  });

  return { tramiteId: tramite.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ?? "BD local Postgres no disponible para tests de documentos",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("documentos service — capa de persistencia", () => {
  it("registrarDocumento crea el registro en BD con todos los campos", async (ctx) => {
    const db = ensureDb(ctx);

    const storageKey = `tramites/DO-TEST-3005/${CategoriaDocumento.FACTURA_COMERCIAL}/${runId}.pdf`;

    const doc = await registrarDocumento({
      tramiteId: db.tramiteId,
      categoria: CategoriaDocumento.FACTURA_COMERCIAL,
      nombreArchivo: "factura-test.pdf",
      storageKey,
      mimeType: "application/pdf",
      tamanoBytes: 102400,
      subidoPorId: db.userId,
    });

    expect(doc.id).toBeTruthy();
    expect(doc.tramiteId).toBe(db.tramiteId);
    expect(doc.categoria).toBe(CategoriaDocumento.FACTURA_COMERCIAL);
    expect(doc.nombreArchivo).toBe("factura-test.pdf");
    expect(doc.storageKey).toBe(storageKey);
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.tamanoBytes).toBe(102400);
    expect(doc.eliminado).toBe(false);
    expect(doc.subidoPorId).toBe(db.userId);
    expect(doc.createdAt).toBeInstanceOf(Date);

    // Verificar AuditLog
    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: doc.id, accion: "CREATE" },
    });
    expect(auditLog).toBeTruthy();
    expect(auditLog?.usuarioId).toBe(db.userId);
  });

  it("listarDocumentos devuelve el documento agrupado por categoría con downloadUrl vacía (sin MinIO)", async (ctx) => {
    const db = ensureDb(ctx);

    const storageKey2 = `tramites/DO-TEST-3005/${CategoriaDocumento.BL}/${runId}-bl.pdf`;

    await registrarDocumento({
      tramiteId: db.tramiteId,
      categoria: CategoriaDocumento.BL,
      nombreArchivo: "bl-test.pdf",
      storageKey: storageKey2,
      mimeType: "application/pdf",
      tamanoBytes: 51200,
      subidoPorId: db.userId,
    });

    const documentosPorCategoria = await listarDocumentos(db.tramiteId);

    // La categoría BL debe existir
    expect(documentosPorCategoria["BL"]).toBeDefined();
    const blDocs = documentosPorCategoria["BL"];
    expect(blDocs.length).toBeGreaterThanOrEqual(1);

    const blDoc = blDocs.find((d) => d.nombreArchivo === "bl-test.pdf");
    expect(blDoc).toBeTruthy();
    expect(blDoc?.categoria).toBe(CategoriaDocumento.BL);
    expect(blDoc?.eliminado).toBe(false);

    // downloadUrl vacía porque MinIO está mockeado para fallar
    expect(blDoc?.downloadUrl).toBe("");

    // subidoPor debe tener datos del usuario
    expect(blDoc?.subidoPor.id).toBe(db.userId);
    expect(blDoc?.subidoPor.name).toBe("Vitest Documentos");
  });

  it("eliminarDocumento hace soft-delete: eliminado=true en BD y no aparece en listarDocumentos", async (ctx) => {
    const db = ensureDb(ctx);

    const storageKey3 = `tramites/DO-TEST-3005/${CategoriaDocumento.PACKING_LIST}/${runId}-pl.pdf`;

    const doc = await registrarDocumento({
      tramiteId: db.tramiteId,
      categoria: CategoriaDocumento.PACKING_LIST,
      nombreArchivo: "packing-list-test.pdf",
      storageKey: storageKey3,
      mimeType: "application/pdf",
      tamanoBytes: 20480,
      subidoPorId: db.userId,
    });

    // Verificar que aparece antes de eliminar
    const antes = await listarDocumentos(db.tramiteId);
    const plAntes = antes["PACKING_LIST"] ?? [];
    expect(plAntes.find((d) => d.id === doc.id)).toBeTruthy();

    // Eliminar
    await eliminarDocumento(doc.id, db.userId);

    // Verificar que eliminado=true en BD
    const persisted = await prisma.documento.findUnique({ where: { id: doc.id } });
    expect(persisted?.eliminado).toBe(true);

    // Verificar que NO aparece en listarDocumentos
    const despues = await listarDocumentos(db.tramiteId);
    const plDespues = despues["PACKING_LIST"] ?? [];
    expect(plDespues.find((d) => d.id === doc.id)).toBeUndefined();

    // Verificar AuditLog de eliminación
    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: doc.id, accion: "DELETE" },
    });
    expect(auditLog).toBeTruthy();
    expect(auditLog?.usuarioId).toBe(db.userId);
  });
});
