/**
 * M2 (revisión INTEG-B) — el aviso «sin gastos de Galcomex» en la respuesta de
 * `POST /api/tramites/[id]/solicitar-facturacion` y en el borrador que ve el
 * revisor (`GET` y `PATCH /api/borradores/[id]`). NO bloquea ni cambia montos.
 * Requiere DATABASE_URL; se omite si no hay BD.
 */

import "dotenv/config";

import { Ciudad, EstadoBorrador, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
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

import { GET as borradorGET, PATCH as borradorPATCH } from "@/app/api/borradores/[id]/route";
import { POST as solicitarPOST } from "@/app/api/tramites/[id]/solicitar-facturacion/route";
import { auth } from "@/lib/auth/auth";
import { AVISO_SIN_GASTOS_GALCOMEX } from "@/lib/borradores/aviso-sin-gastos";
import { prisma } from "@/lib/db/prisma";
import { createTramite } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-m2-route";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CODIGO_CONCEPTO = `VITEST_M2R_${Date.now().toString(36).toUpperCase()}`;
const ANIO = 3032;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let creditoId = "";
let anticiposId = "";
let contador = 0;

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest M2 route",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-m2",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "token-m2",
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

const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });
const postSolicitar = () =>
  new NextRequest("http://localhost/api/tramites/x/solicitar-facturacion", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
  });
const getBorrador = () => new NextRequest("http://localhost/api/borradores/x");
const patchBorrador = (cuerpo: unknown) =>
  new NextRequest("http://localhost/api/borradores/x", {
    method: "PATCH",
    body: JSON.stringify(cuerpo),
    headers: { "content-type": "application/json" },
  });

async function nuevoOtros(clienteId: string) {
  contador += 1;
  return createTramite({
    tipoTramiteCodigo: "OTRO",
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId,
    creadoPorId: usuarioId,
    referenciaExterna: `M2 ROUTE ${contador}`,
    valorServicio: 500_000n,
    conceptoServicioCodigo: CODIGO_CONCEPTO,
  });
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
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: CODIGO_CONCEPTO } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describe("M2 — aviso «sin gastos de Galcomex» en la API", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const user = await prisma.user.create({
        data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest M2 route", rol: Rol.ADMIN },
      });
      usuarioId = user.id;
      await prisma.conceptoVenta.create({
        data: { codigo: CODIGO_CONCEPTO, nombre: "SERVICIO VITEST M2 ROUTE", aplicaIva: true },
      });
      const conceptos = { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 15 } };
      creditoId = (
        await prisma.cliente.create({
          data: {
            nombre: "CREDITO VITEST M2 ROUTE",
            nit: `${RUN_ID}-credito`,
            tipo: TipoCliente.PROPIO,
            capacidades: { create: [{ codigo: "anticipos_cliente", habilitado: false }, conceptos] },
          },
        })
      ).id;
      anticiposId = (
        await prisma.cliente.create({
          data: {
            nombre: "ANTICIPOS VITEST M2 ROUTE",
            nit: `${RUN_ID}-anticipos`,
            tipo: TipoCliente.PROPIO,
            capacidades: { create: [{ codigo: "anticipos_cliente", habilitado: true }, conceptos] },
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

  it("solicitar facturación de un DO de empresa sin anticipos y sin gastos: sigue pasando (200) y trae el aviso; el revisor lo ve en GET y PATCH", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    const t = await nuevoOtros(creditoId);

    const res = await solicitarPOST(postSolicitar(), ctxId(t.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      message: "Trámite enviado a facturar",
      avisoSinGastos: AVISO_SIN_GASTOS_GALCOMEX,
    });
    expect((await prisma.tramiteDO.findUniqueOrThrow({ where: { id: t.id } })).estado).toBe(
      EstadoTramite.ENVIADO_A_FACTURAR,
    );

    // El borrador que se crea al mandar a facturar: el revisor recibe el aviso, con los montos de siempre.
    const borrador = await prisma.borradorFactura.findFirstOrThrow({ where: { tramiteId: t.id } });
    const leido = await borradorGET(getBorrador(), ctxId(borrador.id));
    expect(leido.status).toBe(200);
    const cuerpoGet = (await leido.json()) as { borrador: { avisoSinGastos?: string | null; totalFacturaLineas: string } };
    expect(cuerpoGet.borrador.avisoSinGastos).toBe(AVISO_SIN_GASTOS_GALCOMEX);
    expect(cuerpoGet.borrador.totalFacturaLineas).toBe("580750");

    // Al pasar a revisión el PATCH lo devuelve también (si no, desaparecería hasta recargar).
    const enRevision = await borradorPATCH(patchBorrador({ nuevoEstado: EstadoBorrador.EN_REVISION }), ctxId(borrador.id));
    expect(enRevision.status).toBe(200);
    const cuerpoPatch = (await enRevision.json()) as { borrador: { estado: string; avisoSinGastos?: string | null } };
    expect(cuerpoPatch.borrador.estado).toBe("EN_REVISION");
    expect(cuerpoPatch.borrador.avisoSinGastos).toBe(AVISO_SIN_GASTOS_GALCOMEX);
  });

  it("con una factura de proveedor que se cobra al cliente no hay aviso (avisoSinGastos: null)", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    const t = await nuevoOtros(creditoId);
    await prisma.facturaProveedor.create({
      data: {
        tramiteId: t.id,
        proveedorNombre: "PROVEEDOR VITEST M2",
        numFactura: `M2R-${RUN_ID.slice(-8)}`,
        concepto: "Puerto",
        valor: 120_000n,
        fecha: new Date(`${ANIO}-02-01T00:00:00Z`),
        repercutible: true,
        subidaPorId: usuarioId,
      },
    });
    const res = await solicitarPOST(postSolicitar(), ctxId(t.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, avisoSinGastos: null });
  });

  it("empresa con anticipos: sin aviso (avisoSinGastos: null)", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.OPERATIVO));
    const t = await nuevoOtros(anticiposId);
    // Un «Otros» (servicio suelto) no exige pagos: pasa igual y no hay aviso porque la empresa fondea con anticipo.
    const res = await solicitarPOST(postSolicitar(), ctxId(t.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, avisoSinGastos: null });
  });
});
