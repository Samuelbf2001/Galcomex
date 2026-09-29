/**
 * M3 — `DELETE /api/clientes/[id]/comisiones/liquidaciones/[tramiteId]`
 * (deshacer una liquidación de comisiones, integración con BD): solo ADMIN,
 * motivo de 10 caracteres o más, 404 si el «Otros» no es de la empresa, 409 si ya
 * tiene una factura aprobada. Requiere DATABASE_URL; se omite si no hay BD.
 */

import "dotenv/config";

import { EstadoBorrador, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
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

import { DELETE as deshacerDELETE } from "@/app/api/clientes/[id]/comisiones/liquidaciones/[tramiteId]/route";
import { auth } from "@/lib/auth/auth";
import { generarBorrador } from "@/lib/borradores/service";
import { liquidarComisiones } from "@/lib/comisiones/liquidacion";
import { registrarComisionTramite } from "@/lib/comisiones/service";
import { prisma } from "@/lib/db/prisma";
import { createTramite } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-deshacer-route";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CODIGO_CONCEPTO = `VITEST_DESR_${Date.now().toString(36).toUpperCase()}`;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let ltransId = "";
let otraEmpresaId = "";
let polyrecZfId = "";

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Deshacer",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-deshacer",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "token-deshacer",
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

const routeCtx = (id: string, tramiteId: string) => ({ params: Promise.resolve({ id, tramiteId }) });

function del(body?: unknown) {
  return new NextRequest("http://localhost/api/clientes/x/comisiones/liquidaciones/y", {
    method: "DELETE",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

let contador = 0;
/** Una liquidación de 2 + 4 contenedores (540.000) de LTRANS; devuelve el «Otros» y sus comisiones. */
async function liquidacionNueva(): Promise<{ tramiteId: string; comisionIds: string[] }> {
  const comisionIds: string[] = [];
  for (const unidades of [2, 4]) {
    contador += 1;
    const tramite = await createTramite({
      ciudad: "BAQ",
      anio: 2094,
      clienteId: polyrecZfId,
      agenciaAduanas: "COLDEX",
      creadoPorId: usuarioId,
      referenciaExterna: `POLYREC ZF VITEST DESHACER ${contador}`,
      numContenedores: unidades,
    });
    const fila = await registrarComisionTramite({ tramiteId: tramite.id, empresaId: ltransId, unidades, usuarioId });
    comisionIds.push(fila!.id);
  }
  const r = await liquidarComisiones({ empresaId: ltransId, comisionIds, usuarioId });
  return { tramiteId: r.tramiteId, comisionIds };
}

async function limpiar() {
  const empresas = await prisma.cliente.findMany({ where: { nit: { startsWith: RUN_ID } }, select: { id: true } });
  const ids = empresas.map((e) => e.id);
  const users = await prisma.user.findMany({ where: { email: { startsWith: RUN_ID } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: ids } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
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
        { entidadId: { in: [...tramiteIds, ...borradorIds, ...ids] } },
      ],
    },
  });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
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

describe("DELETE /api/clientes/[id]/comisiones/liquidaciones/[tramiteId]", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const user = await prisma.user.create({
        data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest Deshacer", rol: Rol.ADMIN },
      });
      usuarioId = user.id;
      await prisma.conceptoVenta.create({
        data: { codigo: CODIGO_CONCEPTO, nombre: "COMISIÓN (vitest deshacer)", aplicaIva: true },
      });
      const capacidadesLtrans = {
        create: [
          {
            codigo: "comision_por_evento",
            habilitado: true,
            config: { unidad: "CONTENEDOR", valor: "90000", conceptoVenta: CODIGO_CONCEPTO, tipoTramite: "OTRO" },
          },
          { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 0 } },
        ],
      };
      ltransId = (
        await prisma.cliente.create({
          data: { nombre: "LTRANS VITEST DESHACER", nit: `${RUN_ID}-ltrans`, tipo: TipoCliente.PROPIO, capacidades: capacidadesLtrans },
        })
      ).id;
      otraEmpresaId = (
        await prisma.cliente.create({
          data: { nombre: "OTRA VITEST DESHACER", nit: `${RUN_ID}-otra`, tipo: TipoCliente.PROPIO, capacidades: capacidadesLtrans },
        })
      ).id;
      polyrecZfId = (
        await prisma.cliente.create({
          data: {
            nombre: "POLYREC ZF VITEST DESHACER",
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
        })
      ).id;
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

  it("sin sesión → 401", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await deshacerDELETE(del({ motivo: "Motivo de prueba largo" }), routeCtx(ltransId, "x"));
    expect(res.status).toBe(401);
  });

  it("solo ADMIN: REVISOR, OPERATIVO y SOCIO reciben 403 y la liquidación sigue en pie", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, comisionIds } = await liquidacionNueva();
    for (const rol of [Rol.REVISOR, Rol.OPERATIVO, Rol.SOCIO]) {
      vi.mocked(auth.api.getSession).mockResolvedValue(sesion(rol));
      const res = await deshacerDELETE(del({ motivo: "Motivo de prueba largo" }), routeCtx(ltransId, tramiteId));
      expect(res.status, `rol ${rol}`).toBe(403);
    }
    const ligadas = await prisma.comisionTramite.count({
      where: { id: { in: comisionIds }, liquidacionTramiteId: tramiteId },
    });
    expect(ligadas).toBe(2);
    expect((await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } })).valorServicio).toBe(540_000n);
  });

  it("motivo ausente o de menos de 10 caracteres → 400 y no cambia nada", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, comisionIds } = await liquidacionNueva();
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    for (const cuerpo of [undefined, {}, { motivo: "" }, { motivo: "corto" }, { motivo: "          " }]) {
      const res = await deshacerDELETE(del(cuerpo), routeCtx(ltransId, tramiteId));
      expect(res.status, JSON.stringify(cuerpo)).toBe(400);
    }
    expect(await prisma.comisionTramite.count({ where: { id: { in: comisionIds }, liquidacionTramiteId: tramiteId } })).toBe(2);
  });

  it("ADMIN → 200: las comisiones vuelven a por facturar y el «Otros» queda anulado; repetirlo → 404", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, comisionIds } = await liquidacionNueva();
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));

    const res = await deshacerDELETE(del({ motivo: "  Faltó un DO en la liquidación " }), routeCtx(ltransId, tramiteId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tramiteId,
      comisiones: 2,
      unidades: 6,
      valorAnulado: "540000",
      borradoresEliminados: 0,
    });
    expect(await prisma.comisionTramite.count({ where: { id: { in: comisionIds }, liquidacionTramiteId: null } })).toBe(2);
    const anulado = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } });
    expect(anulado).toMatchObject({ valorServicio: null, estado: EstadoTramite.CERRADO });
    expect(anulado.comentarios).toBe("ANULADO: Faltó un DO en la liquidación");

    const repetido = await deshacerDELETE(del({ motivo: "Faltó un DO en la liquidación" }), routeCtx(ltransId, tramiteId));
    expect(repetido.status).toBe(404);
  });

  it("el motivo también se acepta en la URL (?motivo=) para clientes que no mandan cuerpo en un DELETE", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId } = await liquidacionNueva();
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    const req = new NextRequest(
      `http://localhost/api/clientes/x/comisiones/liquidaciones/${tramiteId}?motivo=${encodeURIComponent("Motivo desde la URL")}`,
      { method: "DELETE" },
    );
    const res = await deshacerDELETE(req, routeCtx(ltransId, tramiteId));
    expect(res.status).toBe(200);
  });

  it("«Otros» de otra empresa → 404; con borrador APROBADO → 409 DESHACER_LIQUIDACION_IMPOSIBLE y sigue todo igual", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, comisionIds } = await liquidacionNueva();
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));

    const ajena = await deshacerDELETE(del({ motivo: "Motivo de prueba largo" }), routeCtx(otraEmpresaId, tramiteId));
    expect(ajena.status).toBe(404);

    await prisma.tramiteDO.update({ where: { id: tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
    const borrador = await generarBorrador({ tramiteId, usuarioId });
    await prisma.borradorFactura.update({ where: { id: borrador.id }, data: { estado: EstadoBorrador.APROBADO } });

    const res = await deshacerDELETE(del({ motivo: "Motivo de prueba largo" }), routeCtx(ltransId, tramiteId));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ codigo: "DESHACER_LIQUIDACION_IMPOSIBLE" });
    expect(await prisma.comisionTramite.count({ where: { id: { in: comisionIds }, liquidacionTramiteId: tramiteId } })).toBe(2);
    expect(await prisma.borradorFactura.count({ where: { id: borrador.id } })).toBe(1);
    expect((await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } })).valorServicio).toBe(540_000n);
  });
});
