/**
 * Tests de integración — marcar el checklist del DO con AuditLog y la regla del
 * ítem "CUADRE DE PLATA HISTÓRICA" (D0, carga histórica 2026).
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida. Si la BD no
 * está disponible, todos los tests se omiten (skip).
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

import { ChecklistItemNoEncontradoError, CuadreHistoricoRolError, actualizarItemChecklist } from "../checklist";
import { TramiteCerradoError } from "../guard";

const TEST_PREFIX = "vitest-checklist-cuadre";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3011;
const CUADRE = "CUADRE DE PLATA HISTÓRICA · ROJO";

type Fixture = { clienteId: string; adminId: string; revisorId: string; operativoId: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let numeroSeq = 0;

async function cleanupTestData() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const tramites = await prisma.tramiteDO.findMany({
    where: { OR: [{ creadoPorId: { in: userIds } }, { clienteId: { in: clientes.map((c) => c.id) } }] },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: userIds } }, { tramiteId: { in: tramiteIds } }] } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clientes.map((c) => c.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function crearUsuario(rol: Rol) {
  const u = await prisma.user.create({
    data: { email: `${TEST_PREFIX}-${rol.toLowerCase()}-${runId}@example.test`, emailVerified: true, name: `Vitest ${rol}`, rol },
  });
  return u.id;
}

async function crearFixture(): Promise<Fixture> {
  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Cuadre", nit: `${TEST_PREFIX}-${runId}`, tipo: TipoCliente.PROPIO },
  });
  return {
    clienteId: cliente.id,
    adminId: await crearUsuario(Rol.ADMIN),
    revisorId: await crearUsuario(Rol.REVISOR),
    operativoId: await crearUsuario(Rol.OPERATIVO),
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local no disponible");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

/** DO con un ítem de checklist. */
async function crearDoConItem(
  db: Fixture,
  opts: { esHistorico: boolean; estado: EstadoTramite; descripcion: string; recibido?: boolean },
) {
  numeroSeq += 1;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.CTG11-${String(numeroSeq).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.CTG,
      anio: stateYear,
      numero: numeroSeq,
      clienteId: db.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.adminId,
      estado: opts.estado,
      esHistorico: opts.esHistorico,
    },
  });
  const item = await prisma.checklistItem.create({
    data: { tramiteId: tramite.id, descripcion: opts.descripcion, requerido: true, recibido: opts.recibido ?? false },
  });
  return { tramiteId: tramite.id, itemId: item.id };
}

const auditsDe = (itemId: string) =>
  prisma.auditLog.findMany({ where: { entidad: "ChecklistItem", entidadId: itemId, accion: "UPDATE_CHECKLIST_ITEM" }, orderBy: { createdAt: "asc" } });

describe("actualizarItemChecklist (Postgres local)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida; se omiten tests de integración con Postgres";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      fixture = await crearFixture();
    } catch (error) {
      dbUnavailableReason = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) await cleanupTestData();
    await prisma.$disconnect();
  });

  it("REVISOR cierra el cuadre de un DO histórico FACTURADO: marca, valida y deja AuditLog con antes/después", async (ctx) => {
    const db = ensureDb(ctx);
    const { tramiteId, itemId } = await crearDoConItem(db, { esHistorico: true, estado: EstadoTramite.FACTURADO, descripcion: CUADRE });

    const item = await actualizarItemChecklist({ tramiteId, itemId, recibido: true, usuarioId: db.revisorId, rol: "REVISOR" });

    expect(item.recibido).toBe(true);
    expect(item.validadoPorId).toBe(db.revisorId);
    expect(item.fechaValidacion).toBeInstanceOf(Date);
    const audits = await auditsDe(itemId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.usuarioId).toBe(db.revisorId);
    expect(audits[0]!.tramiteId).toBe(tramiteId);
    expect(audits[0]!.antes).toMatchObject({ descripcion: CUADRE, recibido: false, validadoPorId: null, fechaValidacion: null });
    expect(audits[0]!.despues).toMatchObject({ descripcion: CUADRE, recibido: true, validadoPorId: db.revisorId, cuadreHistorico: true });
    expect(typeof (audits[0]!.despues as { fechaValidacion?: unknown }).fechaValidacion).toBe("string");

    // ADMIN lo reabre: otro AuditLog, vuelve a pendiente.
    const reabierto = await actualizarItemChecklist({ tramiteId, itemId, recibido: false, usuarioId: db.adminId, rol: "ADMIN" });
    expect(reabierto.recibido).toBe(false);
    expect(reabierto.validadoPorId).toBeNull();
    expect(reabierto.fechaValidacion).toBeNull();
    const audits2 = await auditsDe(itemId);
    expect(audits2).toHaveLength(2);
    expect(audits2[1]!.usuarioId).toBe(db.adminId);
    expect(audits2[1]!.antes).toMatchObject({ recibido: true, validadoPorId: db.revisorId });
    expect(audits2[1]!.despues).toMatchObject({ recibido: false, validadoPorId: null, cuadreHistorico: true });
  });

  it("OPERATIVO no puede cerrar el cuadre: 403, sin cambio y sin AuditLog", async (ctx) => {
    const db = ensureDb(ctx);
    const { tramiteId, itemId } = await crearDoConItem(db, { esHistorico: true, estado: EstadoTramite.FACTURADO, descripcion: CUADRE });

    const error = await actualizarItemChecklist({ tramiteId, itemId, recibido: true, usuarioId: db.operativoId, rol: "OPERATIVO" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CuadreHistoricoRolError);
    expect((error as CuadreHistoricoRolError).status).toBe(403);
    const fila = await prisma.checklistItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(fila.recibido).toBe(false);
    expect(fila.validadoPorId).toBeNull();
    expect(await auditsDe(itemId)).toHaveLength(0);
  });

  it("DO CERRADO: 409 para cualquier rol, sin cambio", async (ctx) => {
    const db = ensureDb(ctx);
    const { tramiteId, itemId } = await crearDoConItem(db, { esHistorico: true, estado: EstadoTramite.CERRADO, descripcion: CUADRE });

    const error = await actualizarItemChecklist({ tramiteId, itemId, recibido: true, usuarioId: db.adminId, rol: "ADMIN" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TramiteCerradoError);
    expect((error as TramiteCerradoError).status).toBe(409);
    expect((await prisma.checklistItem.findUniqueOrThrow({ where: { id: itemId } })).recibido).toBe(false);
    expect(await auditsDe(itemId)).toHaveLength(0);
  });

  it("el mismo texto en un DO NO histórico es un ítem normal: OPERATIVO sí lo marca", async (ctx) => {
    const db = ensureDb(ctx);
    const { tramiteId, itemId } = await crearDoConItem(db, { esHistorico: false, estado: EstadoTramite.FACTURADO, descripcion: CUADRE });

    const item = await actualizarItemChecklist({ tramiteId, itemId, recibido: true, usuarioId: db.operativoId, rol: "OPERATIVO" });

    expect(item.recibido).toBe(true);
    const audits = await auditsDe(itemId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.despues).toMatchObject({ cuadreHistorico: false });
  });

  it("un ítem normal marcado por OPERATIVO en EN_TRAMITE sigue funcionando y ahora deja AuditLog", async (ctx) => {
    const db = ensureDb(ctx);
    const { tramiteId, itemId } = await crearDoConItem(db, { esHistorico: false, estado: EstadoTramite.EN_TRAMITE, descripcion: "Factura comercial" });

    const item = await actualizarItemChecklist({ tramiteId, itemId, recibido: true, usuarioId: db.operativoId, rol: "OPERATIVO" });

    expect(item.recibido).toBe(true);
    expect(item.validadoPorId).toBe(db.operativoId);
    const audits = await auditsDe(itemId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.despues).toMatchObject({ descripcion: "Factura comercial", recibido: true, cuadreHistorico: false });
  });

  it("marcar el mismo valor que ya tiene no escribe nada (ni AuditLog)", async (ctx) => {
    const db = ensureDb(ctx);
    const { tramiteId, itemId } = await crearDoConItem(db, { esHistorico: true, estado: EstadoTramite.FACTURADO, descripcion: CUADRE, recibido: true });
    const antes = await prisma.checklistItem.findUniqueOrThrow({ where: { id: itemId } });

    const item = await actualizarItemChecklist({ tramiteId, itemId, recibido: true, usuarioId: db.adminId, rol: "ADMIN" });

    expect(item.recibido).toBe(true);
    expect(await prisma.checklistItem.findUniqueOrThrow({ where: { id: itemId } })).toEqual(antes);
    expect(await auditsDe(itemId)).toHaveLength(0);
  });

  it("ítem de otro trámite: 404", async (ctx) => {
    const db = ensureDb(ctx);
    const a = await crearDoConItem(db, { esHistorico: true, estado: EstadoTramite.FACTURADO, descripcion: CUADRE });
    const b = await crearDoConItem(db, { esHistorico: true, estado: EstadoTramite.FACTURADO, descripcion: CUADRE });

    const error = await actualizarItemChecklist({ tramiteId: a.tramiteId, itemId: b.itemId, recibido: true, usuarioId: db.adminId, rol: "ADMIN" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChecklistItemNoEncontradoError);
    expect((error as ChecklistItemNoEncontradoError).status).toBe(404);
    expect((await prisma.checklistItem.findUniqueOrThrow({ where: { id: b.itemId } })).recibido).toBe(false);
  });
});
