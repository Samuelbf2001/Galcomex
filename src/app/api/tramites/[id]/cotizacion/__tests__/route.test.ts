/**
 * B7 — `GET /api/tramites/[id]/cotizacion` y `.../cotizacion/pdf` (integración
 * con BD): permisos por rol (ADMIN, REVISOR y OPERATIVO; no SOCIO ni sin
 * sesión), el JSON con la cuenta de la factura, el PDF y el 422 cuando no hay
 * tarifa. Requiere DATABASE_URL; se omite si no hay BD.
 */

import "dotenv/config";

import { Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
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

import { GET as cotizacionGET } from "@/app/api/tramites/[id]/cotizacion/route";
import { GET as cotizacionPdfGET } from "@/app/api/tramites/[id]/cotizacion/pdf/route";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { cambiarEstadoTarifario, crearTarifario } from "@/lib/tarifas/service";
import type { TarifaItemPayload } from "@/lib/validations/tarifas";

const TEST_PREFIX = "vitest-cot-route";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 3015;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let conTarifaId = "";
let sinTarifaId = "";
let tramiteConTarifaId = "";
let tramiteSinTarifaId = "";
let contador = 0;

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Cotización Route",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-cotizacion",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "token-cotizacion",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

const ensureDb = (ctx: { skip: (note?: string) => void }) => {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
};
const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (sufijo: string) => new NextRequest(`http://localhost/api/tramites/x/cotizacion${sufijo}`);

function fijo(concepto: string, orden: number, valor: bigint): TarifaItemPayload {
  return {
    concepto,
    nombrePublico: concepto,
    siigoCodigo: null,
    tipoCalculo: "FIJO",
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    notas: null,
    orden,
    restaAgenciamiento: false,
    minimoEsDelTotal: false,
  };
}

async function nuevoDo(clienteId: string): Promise<string> {
  contador += 1;
  const t = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ15-${String(contador).padStart(4, "0")}-${RUN_ID}`,
      tipoTramiteCodigo: "IMPORTACION",
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      numero: contador,
      clienteId,
      creadoPorId: usuarioId,
      comentarios: RUN_ID,
      estado: EstadoTramite.EN_TRAMITE,
    },
  });
  return t.id;
}

async function limpiar() {
  const empresas = await prisma.cliente.findMany({ where: { nit: { startsWith: RUN_ID } }, select: { id: true } });
  const ids = empresas.map((e) => e.id);
  const users = await prisma.user.findMany({ where: { email: { startsWith: RUN_ID } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: ids } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  const tarifarios = await prisma.tarifario.findMany({ where: { empresaId: { in: ids } }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...tarifarios.map((t) => t.id), ...ids] } },
      ],
    },
  });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describe("GET /api/tramites/[id]/cotizacion (y /pdf)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const user = await prisma.user.create({
        data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest Cotización Route", rol: Rol.ADMIN },
      });
      usuarioId = user.id;
      const capacidades = [
        { codigo: "tarifario_propio", habilitado: true },
        { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 15, observacionNoRetenciones: true } },
      ];
      const conTarifa = await prisma.cliente.create({
        data: { nombre: "CON TARIFA VITEST ROUTE", nit: `${RUN_ID}-con`, tipo: TipoCliente.PROPIO, capacidades: { create: capacidades } },
      });
      const sinTarifa = await prisma.cliente.create({
        data: { nombre: "SIN TARIFA VITEST ROUTE", nit: `${RUN_ID}-sin`, tipo: TipoCliente.PROPIO, capacidades: { create: capacidades } },
      });
      conTarifaId = conTarifa.id;
      sinTarifaId = sinTarifa.id;
      const tarifario = await crearTarifario({
        empresaId: conTarifaId,
        usuarioId,
        nombre: `Tarifa ${RUN_ID}`,
        alcance: "TRAMITE",
        vigenteDesde: new Date("2020-01-01"),
        vigenteHasta: new Date("2035-12-31"),
        notas: null,
        items: [fijo("HONORARIOS", 10, 300_000n), fijo("SERVICIO_LOGISTICO", 20, 107_000n)],
      });
      await cambiarEstadoTarifario(tarifario.id, "VIGENTE", usuarioId);
      tramiteConTarifaId = await nuevoDo(conTarifaId);
      tramiteSinTarifaId = await nuevoDo(sinTarifaId);
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

  it("sin sesión → 401; SOCIO → 403 (JSON y PDF)", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    expect((await cotizacionGET(request(""), routeCtx(tramiteConTarifaId))).status).toBe(401);
    expect((await cotizacionPdfGET(request("/pdf"), routeCtx(tramiteConTarifaId))).status).toBe(401);

    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.SOCIO));
    expect((await cotizacionGET(request(""), routeCtx(tramiteConTarifaId))).status).toBe(403);
    expect((await cotizacionPdfGET(request("/pdf"), routeCtx(tramiteConTarifaId))).status).toBe(403);
  });

  it("ADMIN, REVISOR y OPERATIVO reciben la cotización en JSON: 407.000 + IVA 77.330 − ReteIVA 11.600 = 472.730 (dinero como texto)", async (ctx) => {
    ensureDb(ctx);
    for (const rol of [Rol.ADMIN, Rol.REVISOR, Rol.OPERATIVO]) {
      vi.mocked(auth.api.getSession).mockResolvedValue(sesion(rol));
      const res = await cotizacionGET(request(""), routeCtx(tramiteConTarifaId));
      expect(res.status, `rol ${rol}`).toBe(200);
      const { cotizacion } = (await res.json()) as {
        cotizacion: {
          baseConceptos: string;
          iva: string;
          retenciones: string;
          totalAGirar: string;
          valorParaOc: { valor: string };
          conceptos: { valor: string }[];
          notaAgencia: unknown;
        };
      };
      expect(cotizacion).toMatchObject({ baseConceptos: "407000", iva: "77330", retenciones: "11600", totalAGirar: "472730" });
      expect(cotizacion.valorParaOc.valor).toBe("407000");
      expect(cotizacion.conceptos.map((c) => c.valor)).toEqual(["300000", "107000"]);
      expect(cotizacion.notaAgencia).toBeNull();
    }
  });

  it("el PDF sale como application/pdf con nombre de archivo del DO", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.OPERATIVO));
    const res = await cotizacionPdfGET(request("/pdf"), routeCtx(tramiteConTarifaId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="cotizacion-DO\.BAQ15-/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("sin tarifa vigente → 422 COTIZACION_INCOMPLETA con el motivo; DO que no existe → 404", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
    for (const [ruta, llamar] of [
      ["", cotizacionGET],
      ["/pdf", cotizacionPdfGET],
    ] as const) {
      const res = await llamar(request(ruta), routeCtx(tramiteSinTarifaId));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        codigo: "COTIZACION_INCOMPLETA",
        error: expect.stringContaining("No hay tarifa para cotizar"),
        pendientes: [],
      });
      expect((await llamar(request(ruta), routeCtx("no-existe"))).status).toBe(404);
    }
  });
});
