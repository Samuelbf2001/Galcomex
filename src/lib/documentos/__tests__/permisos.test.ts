/**
 * Tests de la matriz de roles para eliminar/reemplazar documentos.
 *
 * Decisión confirmada por el usuario (2026-08-26):
 *  - ADMIN y REVISOR: eliminan y reemplazan cualquier documento.
 *  - OPERATIVO: sube, y reemplaza SOLO documentos que él mismo subió. No elimina.
 *  - SOCIO: solo sube. No reemplaza ni elimina.
 *
 * Dos capas de test:
 *  1. Unitarios puros sobre puedeEliminarDocumento / puedeReemplazarDocumento
 *     (los 4 roles × las 2 acciones) — no requieren BD.
 *  2. Integración contra Postgres local (mismo patrón que service.test.ts):
 *     verifican que eliminarDocumento()/reemplazarDocumento() apliquen la
 *     matriz de verdad (403 DocumentoPermisoError cuando corresponde) y que
 *     el reemplazo deje rastro en AuditLog.
 */

import "dotenv/config";

import { CategoriaDocumento, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/prisma";

// ─── Mock de storage (igual que service.test.ts) ─────────────────────────────
vi.mock("@/lib/storage/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage/service")>();
  return {
    ...original,
    createPresignedDownloadUrl: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
    softDeleteStorageObject: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
    createPresignedUploadUrl: vi.fn().mockRejectedValue(new Error("MinIO no disponible en tests")),
  };
});

import {
  DocumentoNoEncontradoError,
  DocumentoPermisoError,
  DocumentoYaEliminadoError,
  eliminarDocumento,
  puedeEliminarDocumento,
  puedeReemplazarDocumento,
  reemplazarDocumento,
  registrarDocumento,
} from "../service";

// ─── 1. Unitarios puros — matriz de roles ────────────────────────────────────

describe("matriz de roles — puedeEliminarDocumento (pura, sin BD)", () => {
  it.each([
    ["ADMIN", true],
    ["REVISOR", true],
    ["OPERATIVO", false],
    ["SOCIO", false],
  ] as const)("%s → eliminar permitido = %s", (rol, esperado) => {
    expect(puedeEliminarDocumento(rol as Rol)).toBe(esperado);
  });
});

describe("matriz de roles — puedeReemplazarDocumento (pura, sin BD)", () => {
  const documentoDe = { subidoPorId: "user-uploader" };

  it.each([
    ["ADMIN", "user-uploader", true],
    ["ADMIN", "otro-user", true],
    ["REVISOR", "user-uploader", true],
    ["REVISOR", "otro-user", true],
    ["OPERATIVO", "user-uploader", true], // reemplaza lo que él mismo subió
    ["OPERATIVO", "otro-user", false], // NO reemplaza lo ajeno
    ["SOCIO", "user-uploader", false],
    ["SOCIO", "otro-user", false],
  ] as const)("%s como usuarioId=%s (doc subido por user-uploader) → %s", (rol, usuarioId, esperado) => {
    expect(puedeReemplazarDocumento(rol as Rol, documentoDe, usuarioId)).toBe(esperado);
  });
});

// ─── 2. Integración contra BD ─────────────────────────────────────────────────

const TEST_PREFIX = "vitest-permisos-doc";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Fixture = {
  tramiteId: string;
  admin: string;
  revisor: string;
  operativo: string; // sube el documento de prueba
  operativo2: string; // OPERATIVO distinto, no subió nada
  socio: string;
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
      OR: [{ creadoPorId: { in: userIds } }, { clienteId: { in: clienteIds } }],
    },
    select: { id: true },
  });
  const tramiteIds = testTramites.map((t) => t.id);

  await prisma.documentoEnlace.deleteMany({ where: { creadoPorId: { in: userIds } } });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ usuarioId: { in: userIds } }, { tramiteId: { in: tramiteIds } }] },
  });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const [admin, revisor, operativo, operativo2, socio] = await Promise.all([
    prisma.user.create({
      data: { email: `${runId}-admin@example.test`, emailVerified: true, name: "Admin Test", rol: Rol.ADMIN },
    }),
    prisma.user.create({
      data: { email: `${runId}-revisor@example.test`, emailVerified: true, name: "Revisor Test", rol: Rol.REVISOR },
    }),
    prisma.user.create({
      data: { email: `${runId}-operativo@example.test`, emailVerified: true, name: "Operativo Test", rol: Rol.OPERATIVO },
    }),
    prisma.user.create({
      data: { email: `${runId}-operativo2@example.test`, emailVerified: true, name: "Operativo2 Test", rol: Rol.OPERATIVO },
    }),
    prisma.user.create({
      data: { email: `${runId}-socio@example.test`, emailVerified: true, name: "Socio Test", rol: Rol.SOCIO },
    }),
  ]);

  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Permisos Doc", nit: `${runId}-nit`, tipo: TipoCliente.PROPIO },
  });

  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ05-${runId.slice(-4)}`,
      ciudad: "BAQ",
      anio: 3005,
      numero: Math.floor(Math.random() * 9000) + 1000,
      clienteId: cliente.id,
      agenciaAduanas: "COLDEX",
      creadoPorId: admin.id,
    },
  });

  return {
    tramiteId: tramite.id,
    admin: admin.id,
    revisor: revisor.id,
    operativo: operativo.id,
    operativo2: operativo2.id,
    socio: socio.id,
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de permisos");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

async function crearDocumentoDePrueba(db: Fixture, subidoPorId: string, sufijo: string) {
  return registrarDocumento({
    tramiteId: db.tramiteId,
    categoria: CategoriaDocumento.OTRO,
    nombreArchivo: `doc-${sufijo}.pdf`,
    storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-${sufijo}.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 1024,
    subidoPorId,
  });
}

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

describe("eliminarDocumento — matriz de roles (integración BD)", () => {
  it("ADMIN puede eliminar cualquier documento", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `admin-elimina-${Date.now()}`);

    await eliminarDocumento(doc.id, db.admin, Rol.ADMIN);

    const persisted = await prisma.documento.findUnique({ where: { id: doc.id } });
    expect(persisted?.eliminado).toBe(true);
  });

  it("REVISOR puede eliminar cualquier documento", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `revisor-elimina-${Date.now()}`);

    await eliminarDocumento(doc.id, db.revisor, Rol.REVISOR);

    const persisted = await prisma.documento.findUnique({ where: { id: doc.id } });
    expect(persisted?.eliminado).toBe(true);
  });

  it("OPERATIVO NO puede eliminar (ni su propio documento) → DocumentoPermisoError 403", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `operativo-no-elimina-${Date.now()}`);

    await expect(eliminarDocumento(doc.id, db.operativo, Rol.OPERATIVO)).rejects.toMatchObject({
      name: "DocumentoPermisoError",
      status: 403,
    });

    // No debe haberse marcado eliminado
    const persisted = await prisma.documento.findUnique({ where: { id: doc.id } });
    expect(persisted?.eliminado).toBe(false);
  });

  it("SOCIO NO puede eliminar → DocumentoPermisoError 403", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `socio-no-elimina-${Date.now()}`);

    await expect(eliminarDocumento(doc.id, db.socio, Rol.SOCIO)).rejects.toBeInstanceOf(
      DocumentoPermisoError,
    );
  });
});

describe("reemplazarDocumento — matriz de roles (integración BD)", () => {
  it("ADMIN puede reemplazar un documento subido por OTRO usuario", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `admin-reemplaza-${Date.now()}`);

    const actualizado = await reemplazarDocumento({
      documentoId: doc.id,
      usuarioId: db.admin,
      rol: Rol.ADMIN,
      storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-admin-nuevo.pdf`,
      nombreArchivo: "nuevo-admin.pdf",
      mimeType: "application/pdf",
      tamanoBytes: 2048,
    });

    expect(actualizado.id).toBe(doc.id); // mismo id (update en sitio)
    expect(actualizado.nombreArchivo).toBe("nuevo-admin.pdf");
    expect(actualizado.tamanoBytes).toBe(2048);
    expect(actualizado.subidoPorId).toBe(db.operativo); // procedencia original se conserva

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: doc.id, accion: "REPLACE" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditLog).toBeTruthy();
    expect(auditLog?.usuarioId).toBe(db.admin);
  });

  it("REVISOR puede reemplazar un documento ajeno", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `revisor-reemplaza-${Date.now()}`);

    const actualizado = await reemplazarDocumento({
      documentoId: doc.id,
      usuarioId: db.revisor,
      rol: Rol.REVISOR,
      storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-revisor-nuevo.pdf`,
      nombreArchivo: "nuevo-revisor.pdf",
      mimeType: "application/pdf",
      tamanoBytes: 3072,
    });

    expect(actualizado.nombreArchivo).toBe("nuevo-revisor.pdf");
  });

  it("OPERATIVO puede reemplazar el documento QUE ÉL MISMO subió", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `operativo-propio-${Date.now()}`);

    const actualizado = await reemplazarDocumento({
      documentoId: doc.id,
      usuarioId: db.operativo,
      rol: Rol.OPERATIVO,
      storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-operativo-nuevo.pdf`,
      nombreArchivo: "nuevo-operativo.pdf",
      mimeType: "application/pdf",
      tamanoBytes: 4096,
    });

    expect(actualizado.nombreArchivo).toBe("nuevo-operativo.pdf");
    expect(actualizado.subidoPorId).toBe(db.operativo);
  });

  it("OPERATIVO NO puede reemplazar un documento subido por OTRO OPERATIVO → 403", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `operativo-ajeno-${Date.now()}`);

    await expect(
      reemplazarDocumento({
        documentoId: doc.id,
        usuarioId: db.operativo2,
        rol: Rol.OPERATIVO,
        storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-operativo2-nuevo.pdf`,
        nombreArchivo: "no-deberia-pasar.pdf",
        mimeType: "application/pdf",
        tamanoBytes: 1,
      }),
    ).rejects.toMatchObject({ name: "DocumentoPermisoError", status: 403 });

    // El documento original no debió cambiar
    const persisted = await prisma.documento.findUnique({ where: { id: doc.id } });
    expect(persisted?.nombreArchivo).not.toBe("no-deberia-pasar.pdf");
  });

  it("SOCIO NO puede reemplazar ningún documento → 403", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `socio-reemplaza-${Date.now()}`);

    await expect(
      reemplazarDocumento({
        documentoId: doc.id,
        usuarioId: db.socio,
        rol: Rol.SOCIO,
        storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-socio-nuevo.pdf`,
        nombreArchivo: "no-deberia-pasar.pdf",
        mimeType: "application/pdf",
        tamanoBytes: 1,
      }),
    ).rejects.toBeInstanceOf(DocumentoPermisoError);
  });

  it("reemplazar un documento ya eliminado → DocumentoYaEliminadoError", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, db.operativo, `ya-eliminado-${Date.now()}`);
    await eliminarDocumento(doc.id, db.admin, Rol.ADMIN);

    await expect(
      reemplazarDocumento({
        documentoId: doc.id,
        usuarioId: db.admin,
        rol: Rol.ADMIN,
        storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-nunca.pdf`,
        nombreArchivo: "nunca.pdf",
        mimeType: "application/pdf",
        tamanoBytes: 1,
      }),
    ).rejects.toBeInstanceOf(DocumentoYaEliminadoError);
  });

  it("reemplazar un documento inexistente → DocumentoNoEncontradoError", async (ctx) => {
    ensureDb(ctx);

    await expect(
      reemplazarDocumento({
        documentoId: "documento-que-no-existe",
        usuarioId: fixture!.admin,
        rol: Rol.ADMIN,
        storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-nunca2.pdf`,
        nombreArchivo: "nunca2.pdf",
        mimeType: "application/pdf",
        tamanoBytes: 1,
      }),
    ).rejects.toBeInstanceOf(DocumentoNoEncontradoError);
  });
});
