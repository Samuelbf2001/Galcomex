/**
 * Tests del módulo de enlaces públicos para compartir documentos
 * (src/lib/documentos/enlaces.ts).
 *
 * Dos capas:
 *  1. Unitarios puros sobre evaluarEnlace() — vencido/revocado/documento
 *     eliminado/válido — sin BD ni mocks de Prisma.
 *  2. Integración contra Postgres local (mismo patrón que service.test.ts):
 *     crear enlace (token único + expiración), idempotencia, revocar,
 *     matriz de roles (ADMIN/REVISOR/OPERATIVO sí, SOCIO no), y
 *     resolverEnlacePublico() de punta a punta.
 */

import "dotenv/config";

import { CategoriaDocumento, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/prisma";

// ─── Mock de storage (los tests de enlaces no tocan MinIO, pero
// registrarDocumento() del fixture pasa por el mismo servicio) ───────────────
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
  crearEnlaceDocumento,
  DocumentoNoEncontradoParaEnlaceError,
  EnlacePermisoError,
  evaluarEnlace,
  obtenerEnlaceActivo,
  puedeCompartirDocumento,
  resolverEnlacePublico,
  revocarEnlace,
} from "../enlaces";
import { registrarDocumento } from "../service";

// ─── 1. Unitarios puros — evaluarEnlace ──────────────────────────────────────

describe("evaluarEnlace (pura, sin BD)", () => {
  const ahora = new Date("2026-08-26T12:00:00.000Z");
  const documentoBase = {
    id: "doc-1",
    nombreArchivo: "factura.pdf",
    storageKey: "tramites/DO-1/OTRO/factura.pdf",
    eliminado: false,
  };

  it("válido: no revocado, no vencido, documento no eliminado", () => {
    const resultado = evaluarEnlace(
      { revocado: false, expiraEn: new Date("2026-09-01T00:00:00.000Z"), documento: documentoBase },
      ahora,
    );
    expect(resultado).toMatchObject({
      valido: true,
      documento: { id: "doc-1", nombreArchivo: "factura.pdf" },
    });
  });

  it("inválido: revocado (aunque no haya vencido)", () => {
    const resultado = evaluarEnlace(
      { revocado: true, expiraEn: new Date("2026-09-01T00:00:00.000Z"), documento: documentoBase },
      ahora,
    );
    expect(resultado).toEqual({ valido: false, razon: "revocado" });
  });

  it("inválido: vencido (expiraEn en el pasado)", () => {
    const resultado = evaluarEnlace(
      { revocado: false, expiraEn: new Date("2026-08-01T00:00:00.000Z"), documento: documentoBase },
      ahora,
    );
    expect(resultado).toEqual({ valido: false, razon: "vencido" });
  });

  it("inválido: documento eliminado (aunque el enlace siga vigente)", () => {
    const resultado = evaluarEnlace(
      {
        revocado: false,
        expiraEn: new Date("2026-09-01T00:00:00.000Z"),
        documento: { ...documentoBase, eliminado: true },
      },
      ahora,
    );
    expect(resultado).toEqual({ valido: false, razon: "documento_eliminado" });
  });

  it("expiraEn 1ms antes de 'ahora' → vencido (borde estricto)", () => {
    const unMsAntes = new Date(ahora.getTime() - 1);
    const resultado = evaluarEnlace(
      { revocado: false, expiraEn: unMsAntes, documento: documentoBase },
      ahora,
    );
    expect(resultado).toEqual({ valido: false, razon: "vencido" });
  });

  it("expiraEn exactamente igual a 'ahora' todavía cuenta como válido (comparación estricta <)", () => {
    const resultado = evaluarEnlace(
      { revocado: false, expiraEn: ahora, documento: documentoBase },
      ahora,
    );
    expect(resultado.valido).toBe(true);
  });
});

describe("puedeCompartirDocumento (pura, sin BD)", () => {
  it.each([
    ["ADMIN", true],
    ["REVISOR", true],
    ["OPERATIVO", true],
    ["SOCIO", false],
  ] as const)("%s → puede compartir = %s", (rol, esperado) => {
    expect(puedeCompartirDocumento(rol as Rol)).toBe(esperado);
  });
});

// ─── 2. Integración contra BD ─────────────────────────────────────────────────

const TEST_PREFIX = "vitest-enlaces-doc";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Fixture = {
  tramiteId: string;
  admin: string;
  operativo: string;
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
    where: { OR: [{ creadoPorId: { in: userIds } }, { clienteId: { in: clienteIds } }] },
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
  const [admin, operativo, socio] = await Promise.all([
    prisma.user.create({
      data: { email: `${runId}-admin@example.test`, emailVerified: true, name: "Admin Test", rol: Rol.ADMIN },
    }),
    prisma.user.create({
      data: { email: `${runId}-operativo@example.test`, emailVerified: true, name: "Operativo Test", rol: Rol.OPERATIVO },
    }),
    prisma.user.create({
      data: { email: `${runId}-socio@example.test`, emailVerified: true, name: "Socio Test", rol: Rol.SOCIO },
    }),
  ]);

  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Enlaces Doc", nit: `${runId}-nit`, tipo: TipoCliente.PROPIO },
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

  return { tramiteId: tramite.id, admin: admin.id, operativo: operativo.id, socio: socio.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de enlaces");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

async function crearDocumentoDePrueba(db: Fixture, sufijo: string) {
  return registrarDocumento({
    tramiteId: db.tramiteId,
    categoria: CategoriaDocumento.OTRO,
    nombreArchivo: `doc-${sufijo}.pdf`,
    storageKey: `tramites/DO-TEST-3005/OTRO/${runId}-${sufijo}.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 1024,
    subidoPorId: db.admin,
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

describe("crearEnlaceDocumento (integración BD)", () => {
  it("crea un enlace con token único y expiración ~7 días en el futuro", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `crear-${Date.now()}`);

    const antes = Date.now();
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);
    const despues = Date.now();

    expect(enlace.token).toBeTruthy();
    expect(enlace.token.length).toBeGreaterThanOrEqual(40); // 32 bytes en base64url ≈ 43 chars
    expect(enlace.documentoId).toBe(doc.id);
    expect(enlace.revocado).toBe(false);
    expect(enlace.creadoPorId).toBe(db.admin);

    const diasEnMs = 7 * 24 * 60 * 60 * 1000;
    const expiraEnMs = enlace.expiraEn.getTime();
    expect(expiraEnMs).toBeGreaterThanOrEqual(antes + diasEnMs - 5000);
    expect(expiraEnMs).toBeLessThanOrEqual(despues + diasEnMs + 5000);

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: enlace.id, accion: "CREATE", entidad: "DocumentoEnlace" },
    });
    expect(auditLog).toBeTruthy();
    expect(auditLog?.usuarioId).toBe(db.admin);
  });

  it("dos documentos distintos obtienen tokens distintos", async (ctx) => {
    const db = ensureDb(ctx);
    const doc1 = await crearDocumentoDePrueba(db, `unico-1-${Date.now()}`);
    const doc2 = await crearDocumentoDePrueba(db, `unico-2-${Date.now()}`);

    const enlace1 = await crearEnlaceDocumento(doc1.id, db.admin, Rol.ADMIN);
    const enlace2 = await crearEnlaceDocumento(doc2.id, db.admin, Rol.ADMIN);

    expect(enlace1.token).not.toBe(enlace2.token);
  });

  it("es idempotente: llamar dos veces sin revocar devuelve el MISMO enlace activo", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `idempotente-${Date.now()}`);

    const primero = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);
    const segundo = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    expect(segundo.id).toBe(primero.id);
    expect(segundo.token).toBe(primero.token);
  });

  const rolesCrearEnlace: Array<{ rol: Rol; permitido: boolean }> = [
    { rol: Rol.ADMIN, permitido: true },
    { rol: Rol.REVISOR, permitido: true },
    { rol: Rol.OPERATIVO, permitido: true },
    { rol: Rol.SOCIO, permitido: false },
  ];

  for (const { rol, permitido } of rolesCrearEnlace) {
    it(`matriz de roles: ${rol} → puede crear enlace = ${permitido}`, async (ctx) => {
      const db = ensureDb(ctx);
      const doc = await crearDocumentoDePrueba(db, `rol-${rol}-${Date.now()}`);
      const usuarioId = rol === "SOCIO" ? db.socio : rol === "OPERATIVO" ? db.operativo : db.admin;

      if (permitido) {
        await expect(crearEnlaceDocumento(doc.id, usuarioId, rol)).resolves.toBeTruthy();
      } else {
        await expect(crearEnlaceDocumento(doc.id, usuarioId, rol)).rejects.toBeInstanceOf(
          EnlacePermisoError,
        );
      }
    });
  }

  it("documento inexistente → DocumentoNoEncontradoParaEnlaceError", async (ctx) => {
    ensureDb(ctx);
    await expect(
      crearEnlaceDocumento("documento-que-no-existe", fixture!.admin, Rol.ADMIN),
    ).rejects.toBeInstanceOf(DocumentoNoEncontradoParaEnlaceError);
  });
});

describe("revocarEnlace (integración BD)", () => {
  it("revoca el enlace: revocado=true + ya no aparece como activo", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `revocar-${Date.now()}`);
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    const actualizado = await revocarEnlace(enlace.id, db.admin, Rol.ADMIN);
    expect(actualizado.revocado).toBe(true);

    const activo = await obtenerEnlaceActivo(doc.id);
    expect(activo).toBeNull();

    const auditLog = await prisma.auditLog.findFirst({
      where: { entidadId: enlace.id, accion: "REVOKE", entidad: "DocumentoEnlace" },
    });
    expect(auditLog).toBeTruthy();
  });

  it("revocar dos veces es idempotente (no lanza)", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `revocar-doble-${Date.now()}`);
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    await revocarEnlace(enlace.id, db.admin, Rol.ADMIN);
    await expect(revocarEnlace(enlace.id, db.admin, Rol.ADMIN)).resolves.toMatchObject({
      revocado: true,
    });
  });

  it("SOCIO no puede revocar → EnlacePermisoError", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `revocar-socio-${Date.now()}`);
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    await expect(revocarEnlace(enlace.id, db.socio, Rol.SOCIO)).rejects.toBeInstanceOf(
      EnlacePermisoError,
    );

    // Sigue activo, no lo tocó
    const activo = await obtenerEnlaceActivo(doc.id);
    expect(activo?.id).toBe(enlace.id);
  });

  it("después de revocar, crearEnlaceDocumento genera uno NUEVO (no reutiliza el revocado)", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `revocar-y-recrear-${Date.now()}`);
    const primero = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);
    await revocarEnlace(primero.id, db.admin, Rol.ADMIN);

    const segundo = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    expect(segundo.id).not.toBe(primero.id);
    expect(segundo.token).not.toBe(primero.token);
    expect(segundo.revocado).toBe(false);
  });
});

describe("resolverEnlacePublico (integración BD, uso público sin sesión)", () => {
  it("token existente, vigente y documento no eliminado → válido", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `publico-valido-${Date.now()}`);
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    const resultado = await resolverEnlacePublico(enlace.token);

    expect(resultado).toMatchObject({
      valido: true,
      documento: { id: doc.id, nombreArchivo: doc.nombreArchivo },
    });
  });

  it("token inexistente → inválido, razón no_encontrado", async (ctx) => {
    ensureDb(ctx);
    const resultado = await resolverEnlacePublico("token-que-nunca-existio");
    expect(resultado).toEqual({ valido: false, razon: "no_encontrado" });
  });

  it("token revocado → inválido, razón revocado", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `publico-revocado-${Date.now()}`);
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);
    await revocarEnlace(enlace.id, db.admin, Rol.ADMIN);

    const resultado = await resolverEnlacePublico(enlace.token);
    expect(resultado).toEqual({ valido: false, razon: "revocado" });
  });

  it("documento eliminado tras crear el enlace → inválido, razón documento_eliminado", async (ctx) => {
    const db = ensureDb(ctx);
    const doc = await crearDocumentoDePrueba(db, `publico-doc-eliminado-${Date.now()}`);
    const enlace = await crearEnlaceDocumento(doc.id, db.admin, Rol.ADMIN);

    // Soft-delete directo en BD (sin pasar por eliminarDocumento, para no
    // depender de MinIO/permisos en este test — solo interesa el flag).
    await prisma.documento.update({ where: { id: doc.id }, data: { eliminado: true } });

    const resultado = await resolverEnlacePublico(enlace.token);
    expect(resultado).toEqual({ valido: false, razon: "documento_eliminado" });
  });
});
