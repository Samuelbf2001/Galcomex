/**
 * B10 — `POST /api/clientes/[id]/comisiones/liquidar` (integración con BD):
 * permisos por rol (solo ADMIN), validación del cuerpo, 201 con el «Otros»
 * creado y 409 si la comisión ya se facturó. Requiere DATABASE_URL; se omite
 * si no hay BD (mismo patrón que el resto de tests de integración).
 */

import "dotenv/config";

import { Rol, TipoCliente } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

import { POST as liquidarPOST } from "@/app/api/clientes/[id]/comisiones/liquidar/route";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { registrarComisionTramite } from "@/lib/comisiones/service";
import { createTramite } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-liq-route";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CODIGO_CONCEPTO = `VITEST_LIQR_${Date.now().toString(36).toUpperCase()}`;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let ltransId = "";
let polyrecZfId = "";

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Liquidar",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-liquidar",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "token-liquidar",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

function post(body: unknown) {
  return new NextRequest("http://localhost/api/clientes/x/comisiones/liquidar", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

let contador = 0;
async function nuevaComision(unidades: number): Promise<string> {
  contador += 1;
  const tramite = await createTramite({
    ciudad: "BAQ",
    anio: 2095,
    clienteId: polyrecZfId,
    agenciaAduanas: "COLDEX",
    creadoPorId: usuarioId,
    referenciaExterna: `POLYREC ZF VITEST ROUTE ${contador}`,
    numContenedores: unidades,
  });
  const fila = await registrarComisionTramite({ tramiteId: tramite.id, empresaId: ltransId, unidades, usuarioId });
  return fila!.id;
}

async function limpiar() {
  const empresas = await prisma.cliente.findMany({ where: { nit: { startsWith: RUN_ID } }, select: { id: true } });
  const ids = empresas.map((e) => e.id);
  const users = await prisma.user.findMany({ where: { email: { startsWith: RUN_ID } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: ids } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...ids] } },
      ],
    },
  });
  await prisma.comisionTramite.deleteMany({
    where: { OR: [{ tramiteId: { in: tramiteIds } }, { empresaId: { in: ids } }] },
  });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: CODIGO_CONCEPTO } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describe("POST /api/clientes/[id]/comisiones/liquidar", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const user = await prisma.user.create({
        data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest Liquidar", rol: Rol.ADMIN },
      });
      usuarioId = user.id;
      await prisma.conceptoVenta.create({
        data: { codigo: CODIGO_CONCEPTO, nombre: "COMISIÓN (vitest route)", aplicaIva: true },
      });
      const ltrans = await prisma.cliente.create({
        data: {
          nombre: "LTRANS VITEST ROUTE",
          nit: `${RUN_ID}-ltrans`,
          tipo: TipoCliente.PROPIO,
          capacidades: {
            create: [
              {
                codigo: "comision_por_evento",
                habilitado: true,
                config: { unidad: "CONTENEDOR", valor: "90000", conceptoVenta: CODIGO_CONCEPTO, tipoTramite: "OTRO" },
              },
              { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 0 } },
            ],
          },
        },
      });
      ltransId = ltrans.id;
      const zf = await prisma.cliente.create({
        data: {
          nombre: "POLYREC ZF VITEST ROUTE",
          nit: `${RUN_ID}-zf`,
          tipo: TipoCliente.PROPIO,
          capacidades: {
            create: [
              { codigo: "do_exige_tarifa_vigente", habilitado: false },
              { codigo: "docs_bl_factura_obligatorios", habilitado: false },
              { codigo: "contenedores_obligatorio", habilitado: true },
            ],
          },
        },
      });
      polyrecZfId = zf.id;
      dbConnected = true;
    } catch (error) {
      dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) await limpiar();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockReset();
  });

  it("sin sesión → 401 y no factura nada", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await liquidarPOST(post({ comisionIds: ["x"] }), routeCtx(ltransId));
    expect(res.status).toBe(401);
  });

  it("solo ADMIN: REVISOR, OPERATIVO y SOCIO reciben 403 y las comisiones siguen por facturar", async (ctx) => {
    ensureDb(ctx);
    const comisionId = await nuevaComision(2);
    for (const rol of [Rol.REVISOR, Rol.OPERATIVO, Rol.SOCIO]) {
      vi.mocked(auth.api.getSession).mockResolvedValue(sesion(rol));
      const res = await liquidarPOST(post({ comisionIds: [comisionId] }), routeCtx(ltransId));
      expect(res.status, `rol ${rol}`).toBe(403);
    }
    const fila = await prisma.comisionTramite.findUniqueOrThrow({ where: { id: comisionId } });
    expect(fila.liquidacionTramiteId).toBeNull();
  });

  it("cuerpo inválido → 400 (lista vacía, id vacío, ciudad desconocida)", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    for (const cuerpo of [{}, { comisionIds: [] }, { comisionIds: [""] }, { comisionIds: ["a"], ciudad: "XXX" }]) {
      const res = await liquidarPOST(post(cuerpo), routeCtx(ltransId));
      expect(res.status, JSON.stringify(cuerpo)).toBe(400);
    }
  });

  it("ADMIN → 201 con el «Otros» y el total sin IVA; repetirlo → 409 COMISION_YA_LIQUIDADA", async (ctx) => {
    ensureDb(ctx);
    const a = await nuevaComision(6);
    const b = await nuevaComision(9);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));

    const res = await liquidarPOST(post({ comisionIds: [a, b] }), routeCtx(ltransId));
    expect(res.status).toBe(201);
    const cuerpo = (await res.json()) as {
      tramiteId: string;
      consecutivo: string;
      total: string;
      unidades: number;
      valorUnitario: string;
    };
    expect(cuerpo).toMatchObject({ total: "1350000", unidades: 15, valorUnitario: "90000" });
    expect(cuerpo.consecutivo).toMatch(/^OTR\d{2}-\d{4}$/);

    const otros = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: cuerpo.tramiteId } });
    expect(otros).toMatchObject({ clienteId: ltransId, valorServicio: 1_350_000n, conceptoServicioCodigo: CODIGO_CONCEPTO });

    const repetido = await liquidarPOST(post({ comisionIds: [a, b] }), routeCtx(ltransId));
    expect(repetido.status).toBe(409);
    expect(await repetido.json()).toMatchObject({ codigo: "COMISION_YA_LIQUIDADA" });
  });

  it("empresa que no existe → 404", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    const res = await liquidarPOST(post({ comisionIds: ["x"] }), routeCtx("no-existe"));
    expect(res.status).toBe(404);
  });
});
