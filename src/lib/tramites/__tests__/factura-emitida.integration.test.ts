/**
 * Tests de integración — «Facturado» solo con factura emitida (decisión de
 * Ernesto, 25-sep-2026, «Tema 2»): entrar a Facturado exige un borrador
 * FACTURADO; el ADMIN lo fuerza solo con motivo escrito (AuditLog
 * `FORZAR_FACTURADO`); «Pagado» se sigue marcando libre.
 *
 * Requiere PostgreSQL con DATABASE_URL definida; sin BD los tests se omiten.
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
import { transitionTramite } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-factura-emitida";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3022;
const MOTIVO = "Va incluido en la factura BAQ-18701 del DO.CTG26-0209";

type Fixture = { clienteId: string; adminId: string; revisorId: string; operativoId: string };

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

  await prisma.auditLog.deleteMany({
    where: { OR: [{ usuarioId: { in: userIds } }, { tramiteId: { in: tramiteIds } }, { entidadId: { in: tramiteIds } }] },
  });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.borradorFactura.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function crearUsuario(rol: Rol) {
  const u = await prisma.user.create({
    data: { email: `${runId}-${rol.toLowerCase()}@example.test`, emailVerified: true, name: `Vitest ${rol}`, rol },
  });
  return u.id;
}

async function crearDo(estado: EstadoTramite, borradores: EstadoBorrador[] = []) {
  numero += 1;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId: fixture!.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: fixture!.adminId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado,
    },
  });
  for (const estadoBorrador of borradores) {
    await prisma.borradorFactura.create({
      data: {
        tramiteId: tramite.id,
        comision: 150_000n,
        ivaComision: 28_500n,
        impuesto4x1000: 0n,
        costosBancarios: 0n,
        totalAnticipo: 0n,
        totalPagos: 0n,
        totalFactura: 178_500n,
        estado: estadoBorrador,
      },
    });
  }
  return tramite;
}

async function estadoDe(id: string) {
  return (await prisma.tramiteDO.findUniqueOrThrow({ where: { id }, select: { estado: true } })).estado;
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD Postgres no disponible para tests de factura emitida");
    throw new Error("Test omitido porque la BD no está disponible");
  }
  return fixture;
}

describe("«Facturado» solo con factura emitida (integración con Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      const cliente = await prisma.cliente.create({
        data: {
          nombre: "Cliente Vitest Factura Emitida",
          nit: `${TEST_PREFIX}-${runId}`,
          tipo: TipoCliente.PROPIO,
          // Este archivo prueba la regla de factura emitida, no D1/D2.
          capacidades: {
            create: [
              { codigo: "do_exige_tarifa_vigente", habilitado: false },
              { codigo: "docs_bl_factura_obligatorios", habilitado: false },
            ],
          },
        },
      });
      fixture = {
        clienteId: cliente.id,
        adminId: await crearUsuario(Rol.ADMIN),
        revisorId: await crearUsuario(Rol.REVISOR),
        operativoId: await crearUsuario(Rol.OPERATIVO),
      };
    } catch (error) {
      dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) await cleanupTestData();
    await prisma.$disconnect();
  });

  it("sin borrador: 422 FACTURA_NO_EMITIDA y el DO no se mueve", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.ENVIADO_A_FACTURAR);

    const r = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, db.operativoId, false, Rol.OPERATIVO);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.codigo).toBe("FACTURA_NO_EMITIDA");
    expect(r.message).toContain(tramite.consecutivo);
    expect(r.message).toContain("todavía no tiene borrador de factura");
    expect(r.detalles).toMatchObject({ consecutivo: tramite.consecutivo, borradores: [], puedeForzar: false });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
    expect(await prisma.estadoLog.count({ where: { tramiteId: tramite.id } })).toBe(0);
  });

  it("borrador aprobado pero sin enviar a Siigo: el REVISOR tampoco pasa, ni con motivo", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.ENVIADO_A_FACTURAR, [EstadoBorrador.APROBADO]);

    const r = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, db.revisorId, false, Rol.REVISOR, {
      motivoExcepcion: MOTIVO,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("aprobado, sin enviar a Siigo");
    expect(r.detalles).toMatchObject({ borradores: [EstadoBorrador.APROBADO], puedeForzar: false });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
  });

  it("con la factura emitida (borrador FACTURADO) cualquier rol lo pasa, aunque tenga otro borrador abierto", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.ENVIADO_A_FACTURAR, [EstadoBorrador.FACTURADO, EstadoBorrador.BORRADOR]);

    const r = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, db.operativoId, false, Rol.OPERATIVO);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.advertencias).toEqual([]);
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.FACTURADO);
    expect(await prisma.auditLog.count({ where: { entidadId: tramite.id, accion: "FORZAR_FACTURADO" } })).toBe(0);
  });

  it("ADMIN sin motivo (o con uno muy corto): 422 pero con la opción de forzar", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.ENVIADO_A_FACTURAR);

    const sinMotivo = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, db.adminId, true, Rol.ADMIN);
    expect(sinMotivo.ok).toBe(false);
    if (!sinMotivo.ok) expect(sinMotivo.detalles).toMatchObject({ puedeForzar: true });

    const corto = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, db.adminId, true, Rol.ADMIN, {
      motivoExcepcion: "   porque   ",
    });
    expect(corto.ok).toBe(false);
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
  });

  it("ADMIN con motivo: pasa, avisa y queda anotado (FORZAR_FACTURADO)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.ENVIADO_A_FACTURAR, [EstadoBorrador.APROBADO]);

    const r = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, db.adminId, true, Rol.ADMIN, {
      motivoExcepcion: `  ${MOTIVO}  `,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.advertencias).toHaveLength(1);
    expect(r.advertencias[0]).toContain("sin factura emitida");
    expect(r.advertencias[0]).toContain(MOTIVO);
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.FACTURADO);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entidadId: tramite.id, accion: "FORZAR_FACTURADO" } });
    expect(audit.usuarioId).toBe(db.adminId);
    expect(audit.antes).toEqual({ estado: "ENVIADO_A_FACTURAR", borradores: ["APROBADO"] });
    expect(audit.despues).toEqual({ estado: "FACTURADO", motivo: MOTIVO });
    expect(await prisma.auditLog.count({ where: { entidadId: tramite.id, accion: "UPDATE_ESTADO" } })).toBe(1);
  });

  it("Pagado se marca libre desde Facturado (no revisa factura ni saldo)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.FACTURADO);

    const r = await transitionTramite(tramite.id, EstadoTramite.PAGADO, db.operativoId, false, Rol.OPERATIVO);

    expect(r.ok).toBe(true);
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.PAGADO);
  });

  it("el ADMIN no se salta la regla yendo directo a Pagado sin factura", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await crearDo(EstadoTramite.DESPACHADO);

    const r = await transitionTramite(tramite.id, EstadoTramite.PAGADO, db.adminId, true, Rol.ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("FACTURA_NO_EMITIDA");

    const forzado = await transitionTramite(tramite.id, EstadoTramite.PAGADO, db.adminId, true, Rol.ADMIN, {
      motivoExcepcion: MOTIVO,
    });
    expect(forzado.ok).toBe(true);
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.PAGADO);
  });

  it("cerrar (descartar) y reabrir un Cerrado no piden factura", async (ctx) => {
    const db = ensureDb(ctx);
    const aDescartar = await crearDo(EstadoTramite.ENVIADO_A_FACTURAR);
    const cerrado = await transitionTramite(aDescartar.id, EstadoTramite.CERRADO, db.adminId, true, Rol.ADMIN);
    expect(cerrado.ok).toBe(true);

    const reabierto = await transitionTramite(aDescartar.id, EstadoTramite.FACTURADO, db.adminId, true, Rol.ADMIN);
    expect(reabierto.ok).toBe(true);
    expect(await estadoDe(aDescartar.id)).toBe(EstadoTramite.FACTURADO);
  });
});
