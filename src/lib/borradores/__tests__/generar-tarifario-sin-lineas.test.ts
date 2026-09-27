/**
 * Tests de integración — tarifario vigente que no propone líneas (26-sep-2026).
 *
 * Hallazgo "borrador-sin-lineas": Polyrec ZF con carga suelta tiene
 * `numContenedores = 0`; su único ítem (POR_TRAMO por CONTENEDOR) da 0 y el
 * tarifario propone 0 líneas y 0 pendientes. Sin `usarTarifario` (MCP
 * `borrador_generar`, scripts) `generarBorrador` caía en silencio a la
 * comisión por defecto (150.000) cuando la factura real es 300.000.
 *
 * Contrato:
 * - Empresa con `tarifario_propio` + tarifario vigente sin líneas para el DO,
 *   sin comisión ni conceptos a mano → `TarifarioNoAplicableError` (409) con o
 *   sin la bandera, y no se crea borrador. POST /api/tramites/[id]/borrador
 *   responde 409.
 * - Con comisión a mano sí se genera (la salida del revisor).
 * - `ensureBorrador` (listado de Facturación) no se rompe: no crea borrador.
 * - Empresa sin la función (Lucho/SOCIO_LM): `propuesta.tarifario` es null y
 *   sigue la comisión por defecto (COMISION_LM), como siempre.
 *
 * Requiere PostgreSQL local con DATABASE_URL definida; si no, skip.
 * TEST_PREFIX único: "vitest-borrador-sin-lineas". Año de datos: 3014.
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  DisparadorTarifa,
  EstadoTarifario,
  EstadoTramite,
  Rol,
  TipoCalculoTarifa,
  TipoCarga,
  TipoCliente,
  TipoRecaudo,
  UnidadTarifa,
} from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ── Mocks de autenticación (solo los usa el POST de la ruta) ─────────────────

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

// ── Importaciones post-mock ───────────────────────────────────────────────────

import { POST as borradorPOST } from "@/app/api/tramites/[id]/borrador/route";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { propuestaParaTramite } from "@/lib/tarifas/service";

import { ensureBorrador, generarBorrador, TarifarioNoAplicableError } from "../service";

const TEST_PREFIX = "vitest-borrador-sin-lineas";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const suf = Date.now().toString(36).toUpperCase();
const stateYear = 3014;
const DIA = 86_400_000;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresas = 0;
let tramites = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
}

function sesionAdmin() {
  return {
    user: {
      id: usuarioId,
      rol: Rol.ADMIN,
      email: `${TEST_PREFIX}-admin-${runId}@example.test`,
      name: "Vitest Borrador Sin Líneas",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-borrador-sin-lineas",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + DIA),
      token: "token-borrador-sin-lineas",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

async function cleanup() {
  const clientes = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const clienteIds = clientes.map((c) => c.id);
  const tramitesDb = await prisma.tramiteDO.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const tramiteIds = tramitesDb.map((t) => t.id);
  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...borradorIds] } },
        { usuario: { email: { startsWith: TEST_PREFIX } } },
      ],
    },
  });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  const anticipos = await prisma.anticipo.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  await prisma.aplicacionAnticipo.deleteMany({
    where: { OR: [{ tramiteId: { in: tramiteIds } }, { anticipoId: { in: anticipos.map((a) => a.id) } }] },
  });
  await prisma.anticipo.deleteMany({ where: { clienteId: { in: clienteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  // TarifaItem cae en cascada; empresa_capacidad también.
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

async function crearEmpresa(
  capacidades: { codigo: string; habilitado: boolean }[],
  tipo: TipoCliente = TipoCliente.PROPIO,
) {
  empresas += 1;
  return prisma.cliente.create({
    data: {
      nombre: `EMPRESA VITEST SIN LINEAS ${empresas}`,
      nit: `${runId}-${empresas}`,
      tipo,
      capacidades: { create: capacidades },
    },
  });
}

/** Tarifario tipo Polyrec ZF: un solo ítem POR_TRAMO por contenedor (1 → 300.000; 2 o más → 250.000 c/u). */
async function crearTarifarioZonaFranca(empresaId: string) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: "Tarifas vitest zona franca",
      alcance: "TRAMITE",
      estado: EstadoTarifario.VIGENTE,
      vigenteDesde: new Date(Date.now() - 30 * DIA),
      vigenteHasta: new Date(Date.now() + 30 * DIA),
      version: 1,
      creadoPorId: usuarioId,
      items: {
        create: [
          {
            orden: 10,
            concepto: `VITEST_SL_${suf}_TRASLADO_ZF`,
            nombrePublico: "Traslado de contenedor en zona franca vitest",
            tipoCalculo: TipoCalculoTarifa.POR_TRAMO,
            disparador: DisparadorTarifa.SIEMPRE,
            unidad: UnidadTarifa.CONTENEDOR,
            valor: 0n,
            tramos: [
              { hasta: 1, valor: "300000" },
              { hasta: null, valor: "250000" },
            ],
            aplicaIva: true,
          },
        ],
      },
    },
  });
}

/** DO facturable con anticipo aplicado (sin pagos) y la base de cálculo dada. */
async function crearTramite(
  clienteId: string,
  base: { tipoCarga: TipoCarga | null; numContenedores: number | null },
) {
  tramites += 1;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(tramites).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero: tramites,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: usuarioId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      tipoCarga: base.tipoCarga,
      numContenedores: base.numContenedores,
    },
  });
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId,
      monto: 5_000_000n,
      fecha: new Date(`${stateYear}-01-10`),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 0n,
      verificadoBanco: true,
    },
  });
  await prisma.aplicacionAnticipo.create({
    data: { anticipoId: anticipo.id, tramiteId: tramite.id, montoAplicado: 5_000_000n },
  });
  return tramite.id;
}

/** Empresa con tarifario propio + DO de carga suelta: el tarifario vigente no propone líneas. */
async function escenarioCargaSuelta() {
  const empresa = await crearEmpresa([
    { codigo: "tarifario_propio", habilitado: true },
    { codigo: "factura_conceptos_iva", habilitado: true },
  ]);
  const tarifario = await crearTarifarioZonaFranca(empresa.id);
  const tramiteId = await crearTramite(empresa.id, { tipoCarga: TipoCarga.SUELTA, numContenedores: 0 });
  return { tarifario, tramiteId };
}

function postRequest(tramiteId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/tramites/${tramiteId}/borrador`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    const catalogo = await prisma.capacidad.count({
      where: { codigo: { in: ["tarifario_propio", "factura_conceptos_iva"] } },
    });
    if (catalogo < 2) {
      dbUnavailableReason = "Faltan capacidades del catálogo (corre el seed)";
      return;
    }
    const parametro = await prisma.parametro.findUnique({ where: { clave: "COMISION_LM" } });
    if (!parametro) {
      dbUnavailableReason = "Falta el parámetro COMISION_LM (corre el seed)";
      return;
    }
    await cleanup();
    const user = await prisma.user.create({
      data: {
        email: `${TEST_PREFIX}-admin-${runId}@example.test`,
        emailVerified: true,
        name: "Vitest Borrador Sin Líneas",
        rol: Rol.ADMIN,
      },
    });
    usuarioId = user.id;
    vi.mocked(auth.api.getSession).mockResolvedValue(sesionAdmin());
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
  }
}, 30_000);

afterAll(async () => {
  if (dbConnected) await cleanup();
  await prisma.$disconnect();
}, 30_000);

describe("tarifario vigente que no propone líneas (Polyrec ZF, carga suelta)", () => {
  it("la propuesta del DO: tarifario vigente, 0 líneas y 0 pendientes", async (ctx) => {
    ensureDb(ctx);
    const { tarifario, tramiteId } = await escenarioCargaSuelta();

    const propuesta = await propuestaParaTramite(tramiteId);

    expect(propuesta.tarifario?.id).toBe(tarifario.id);
    expect(propuesta.resultado?.lineas).toEqual([]);
    expect(propuesta.resultado?.pendientes).toEqual([]);
    expect(propuesta.resultado?.total).toBe(0n);
  });

  it("servicio sin usarTarifario ni comisión (MCP, scripts): 409 y no crea borrador, nunca 150.000", async (ctx) => {
    ensureDb(ctx);
    const { tarifario, tramiteId } = await escenarioCargaSuelta();

    const error = await generarBorrador({ tramiteId, retenciones: 0n, usuarioId }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as TarifarioNoAplicableError).status).toBe(409);
    expect((error as Error).message).toContain(
      `el tarifario ${tarifario.nombre} v${tarifario.version} no propone líneas para este trámite`,
    );
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("con usarTarifario: el mismo 409 de siempre", async (ctx) => {
    ensureDb(ctx);
    const { tarifario, tramiteId } = await escenarioCargaSuelta();

    const error = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: tarifario.id,
      usuarioId,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as TarifarioNoAplicableError).status).toBe(409);
    expect((error as Error).message).toContain("no propone líneas");
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("con la comisión a mano (300.000) sí se genera: es la salida del revisor", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId } = await escenarioCargaSuelta();

    const borrador = await generarBorrador({ tramiteId, comision: 300_000n, usuarioId });

    expect(borrador.comision).toBe(300_000n);
    expect(borrador.tarifarioId).toBeNull();
  });

  it("POST /api/tramites/[id]/borrador sin bandera ni comisión: 409 y no crea borrador", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId } = await escenarioCargaSuelta();

    const res = await borradorPOST(postRequest(tramiteId, { retenciones: "0" }), {
      params: Promise.resolve({ id: tramiteId }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no propone líneas");
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("ensureBorrador (listado de Facturación) no falla y no crea borrador", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId } = await escenarioCargaSuelta();

    await expect(ensureBorrador(tramiteId, usuarioId)).resolves.toBeUndefined();

    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("con 1 contenedor el mismo tarifario sí propone la línea de 300.000 (sin bandera)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const tarifario = await crearTarifarioZonaFranca(empresa.id);
    const tramiteId = await crearTramite(empresa.id, {
      tipoCarga: TipoCarga.CONTENEDOR_40,
      numContenedores: 1,
    });

    const borrador = await generarBorrador({ tramiteId, usuarioId });

    expect(borrador.tarifarioId).toBe(tarifario.id);
    expect(borrador.comision).toBe(300_000n);
  });
});

describe("empresa sin tarifario propio (Lucho / SOCIO_LM): nada cambia", () => {
  it("SOCIO_LM: propuesta.tarifario es null y sin comisión se usa COMISION_LM", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: false }], TipoCliente.SOCIO_LM);
    const tramiteId = await crearTramite(empresa.id, { tipoCarga: TipoCarga.SUELTA, numContenedores: 0 });
    const parametro = await prisma.parametro.findUniqueOrThrow({ where: { clave: "COMISION_LM" } });
    const comisionLM = BigInt(parametro.valor);

    const propuesta = await propuestaParaTramite(tramiteId);
    expect(propuesta.tarifario).toBeNull();
    expect(propuesta.resultado).toBeNull();

    const borrador = await generarBorrador({ tramiteId, usuarioId });

    // En SOCIO_LM la línea COMISION no se materializa (queda en 0 en el
    // espejo); la comisión por defecto se ve en el cruce interno y en el IVA.
    const db = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borrador.id },
      select: { tarifarioId: true, comisionInternaLM: true, ivaComision: true },
    });
    expect(db.tarifarioId).toBeNull();
    expect(db.comisionInternaLM).toBe(comisionLM);
    expect(db.ivaComision).toBe((comisionLM * 19n) / 100n);
  });

  it("PROPIO sin la función: sin comisión la factura lleva COMISION_LM", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: false }]);
    const tramiteId = await crearTramite(empresa.id, { tipoCarga: TipoCarga.SUELTA, numContenedores: 0 });
    const parametro = await prisma.parametro.findUniqueOrThrow({ where: { clave: "COMISION_LM" } });

    expect((await propuestaParaTramite(tramiteId)).tarifario).toBeNull();

    const borrador = await generarBorrador({ tramiteId, usuarioId });

    expect(borrador.tarifarioId).toBeNull();
    expect(borrador.comision).toBe(BigInt(parametro.valor));
  });
});
