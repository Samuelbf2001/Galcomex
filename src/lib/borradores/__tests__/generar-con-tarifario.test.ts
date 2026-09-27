/**
 * Tests de integración — generarBorrador con tarifario propio (M2), 24-sep-2026.
 *
 * Contrato que usa el modal "Generar borrador" de Facturación:
 * - SIN comisión ni conceptos + empresa con `tarifario_propio` y tarifario
 *   vigente → las líneas y la comisión salen del tarifario (`tarifarioId`).
 * - CON comisión (lo que el modal mandaba siempre: 150.000) → se ignora el
 *   tarifario. Por eso el modal ya no la manda salvo "Usar otra comisión".
 * - Con pendientes en la base de cálculo → `TarifaIncompletaError` (422).
 * - Empresa sin la función → comisión por defecto, como siempre.
 *
 * Hallazgos 1 y 2 de la revisión del modal (24-sep):
 * - `usarTarifario` (+ `tarifarioIdEsperado`): si el servidor no puede aplicar
 *   el tarifario que el revisor vio → `TarifarioNoAplicableError` (409), nunca
 *   la comisión por defecto.
 * - "Hoy" es el día calendario en Bogotá: a las 19:30 del último día de
 *   vigencia (00:30Z del día siguiente) sigue rigiendo la versión que vence y
 *   la nueva todavía no.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida; si no, skip.
 * TEST_PREFIX único: "vitest-borrador-tarifario". Año de datos: 3013.
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
  TipoCliente,
  TipoRecaudo,
  UnidadTarifa,
} from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { propuestaParaTramite } from "@/lib/tarifas/service";
import { generarBorradorPayloadSchema } from "@/lib/validations/borradores";

import {
  ensureBorrador,
  generarBorrador,
  TarifaIncompletaError,
  TarifarioNoAplicableError,
} from "../service";

const TEST_PREFIX = "vitest-borrador-tarifario";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const suf = Date.now().toString(36).toUpperCase();
const stateYear = 3013;
const DIA = 86_400_000;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresas = 0;
let tramites = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
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

async function crearEmpresa(capacidades: { codigo: string; habilitado: boolean }[]) {
  empresas += 1;
  return prisma.cliente.create({
    data: {
      nombre: `EMPRESA VITEST TARIFARIO ${empresas}`,
      nit: `${runId}-${empresas}`,
      tipo: TipoCliente.PROPIO,
      capacidades: { create: capacidades },
    },
  });
}

type ItemFixture = {
  concepto: string;
  nombrePublico: string;
  tipoCalculo: TipoCalculoTarifa;
  valor?: bigint;
  porcentajeBps?: number;
  minimos?: Record<string, string>;
};

async function crearTarifarioVigente(empresaId: string, items: ItemFixture[]) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: "Tarifas vitest",
      alcance: "TRAMITE",
      estado: EstadoTarifario.VIGENTE,
      vigenteDesde: new Date(Date.now() - 30 * DIA),
      vigenteHasta: new Date(Date.now() + 30 * DIA),
      version: 1,
      creadoPorId: usuarioId,
      items: {
        create: items.map((it, orden) => ({
          orden,
          concepto: it.concepto,
          nombrePublico: it.nombrePublico,
          tipoCalculo: it.tipoCalculo,
          disparador: DisparadorTarifa.SIEMPRE,
          unidad: UnidadTarifa.TRAMITE,
          valor: it.valor ?? 0n,
          porcentajeBps: it.porcentajeBps ?? null,
          minimos: it.minimos ?? undefined,
          aplicaIva: true,
        })),
      },
    },
  });
}

/** Tarifario VIGENTE con fechas fijas (días calendario a 00:00 UTC, como los guarda la app). */
async function crearTarifarioEnFechas(
  empresaId: string,
  items: ItemFixture[],
  opts: { desde: string; hasta: string; version: number; nombre?: string; disparador?: DisparadorTarifa },
) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: opts.nombre ?? `Tarifas vitest v${opts.version}`,
      alcance: "TRAMITE",
      estado: EstadoTarifario.VIGENTE,
      vigenteDesde: new Date(`${opts.desde}T00:00:00.000Z`),
      vigenteHasta: new Date(`${opts.hasta}T00:00:00.000Z`),
      version: opts.version,
      creadoPorId: usuarioId,
      items: {
        create: items.map((it, orden) => ({
          orden,
          concepto: it.concepto,
          nombrePublico: it.nombrePublico,
          tipoCalculo: it.tipoCalculo,
          disparador: opts.disparador ?? DisparadorTarifa.SIEMPRE,
          unidad: UnidadTarifa.TRAMITE,
          valor: it.valor ?? 0n,
          porcentajeBps: it.porcentajeBps ?? null,
          minimos: it.minimos ?? undefined,
          aplicaIva: true,
        })),
      },
    },
  });
}

/** DO facturable con anticipo aplicado (sin pagos), sin base de cálculo. */
async function crearTramite(clienteId: string) {
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

const GT = `VITEST_TAR_${suf}_GT`;
const SIS = `VITEST_TAR_${suf}_SIS`;
const AGE = `VITEST_TAR_${suf}_AGE`;

const ITEMS_FIJOS: ItemFixture[] = [
  { concepto: GT, nombrePublico: "Gastos de trámite vitest", tipoCalculo: TipoCalculoTarifa.FIJO, valor: 380_000n },
  { concepto: SIS, nombrePublico: "Sistematización vitest", tipoCalculo: TipoCalculoTarifa.FIJO, valor: 95_000n },
];

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
        name: "Vitest Borrador Tarifario",
        rol: Rol.ADMIN,
      },
    });
    usuarioId = user.id;
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
  }
}, 30_000);

afterAll(async () => {
  if (dbConnected) await cleanup();
  await prisma.$disconnect();
}, 30_000);

describe("payload del POST /api/tramites/[id]/borrador", () => {
  it("sin comisión el schema la deja undefined (el servidor puede usar el tarifario)", () => {
    const payload = generarBorradorPayloadSchema.parse({ retenciones: "0" });
    expect(payload.comision).toBeUndefined();
    expect(payload.conceptosOperacionales).toBeUndefined();
  });

  it("acepta usarTarifario + tarifarioId (lo que manda el modal)", () => {
    const payload = generarBorradorPayloadSchema.parse({ usarTarifario: true, tarifarioId: "t-1", retenciones: "0" });
    expect(payload.usarTarifario).toBe(true);
    expect(payload.tarifarioId).toBe("t-1");
  });

  it("rechaza usarTarifario junto con comisión o conceptos a mano", () => {
    expect(generarBorradorPayloadSchema.safeParse({ usarTarifario: true, comision: "150000" }).success).toBe(false);
    expect(
      generarBorradorPayloadSchema.safeParse({
        usarTarifario: true,
        conceptosOperacionales: [{ concepto: "X", valor: "1" }],
      }).success,
    ).toBe(false);
  });

  it("rechaza tarifarioId sin usarTarifario", () => {
    expect(generarBorradorPayloadSchema.safeParse({ tarifarioId: "t-1" }).success).toBe(false);
  });

  it("acepta totalTarifario (el total que vio el revisor) solo con usarTarifario", () => {
    const payload = generarBorradorPayloadSchema.parse({ usarTarifario: true, tarifarioId: "t-1", totalTarifario: "475000" });
    expect(payload.totalTarifario).toBe(475_000n);
    expect(generarBorradorPayloadSchema.safeParse({ totalTarifario: "475000" }).success).toBe(false);
  });
});

describe("generarBorrador con tarifario propio", () => {
  it("sin comisión: la comisión y las líneas salen del tarifario vigente", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "factura_conceptos_iva", habilitado: true },
    ]);
    const tarifario = await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);

    const borrador = await generarBorrador({ tramiteId, retenciones: 0n, usuarioId });

    const db = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borrador.id },
      select: {
        comision: true,
        tarifarioId: true,
        lineasRevision: { select: { concepto: true, valor: true } },
      },
    });
    expect(db.tarifarioId).toBe(tarifario.id);
    expect(db.comision).toBe(475_000n);
    const lineas = new Map(db.lineasRevision.map((l) => [l.concepto, l.valor]));
    expect(lineas.get("Gastos de trámite vitest")).toBe(380_000n);
    expect(lineas.get("Sistematización vitest")).toBe(95_000n);
    // Nunca la línea única de 150.000 del bug.
    expect(db.lineasRevision.some((l) => l.valor === 150_000n)).toBe(false);
  });

  it("con comisión explícita (lo que mandaba el modal: 150.000) el tarifario se ignora", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "factura_conceptos_iva", habilitado: true },
    ]);
    await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);

    const borrador = await generarBorrador({ tramiteId, comision: 150_000n, usuarioId });

    const db = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borrador.id },
      select: { comision: true, tarifarioId: true, lineasRevision: { select: { concepto: true } } },
    });
    expect(db.tarifarioId).toBeNull();
    expect(db.comision).toBe(150_000n);
    expect(db.lineasRevision.map((l) => l.concepto)).not.toContain("Gastos de trámite vitest");
  });

  it("con pendientes en la base de cálculo y sin comisión: TarifaIncompletaError (422), no factura de menos", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    await crearTarifarioVigente(empresa.id, [
      ...ITEMS_FIJOS,
      {
        concepto: AGE,
        nombrePublico: "Agenciamiento vitest",
        tipoCalculo: TipoCalculoTarifa.PORCENTAJE_MIN,
        porcentajeBps: 37,
        minimos: { SUELTA: "500000", CONTENEDOR_20: "600000", CONTENEDOR_40: "700000" },
      },
    ]);
    const tramiteId = await crearTramite(empresa.id);

    const error = await generarBorrador({ tramiteId, usuarioId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifaIncompletaError);
    expect((error as TarifaIncompletaError).status).toBe(422);
    expect((error as TarifaIncompletaError).pendientes.map((p) => p.nombrePublico)).toEqual([
      "Agenciamiento vitest",
    ]);
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);

    // "Usar otra comisión": con comisión a mano sí se genera.
    const manual = await generarBorrador({ tramiteId, comision: 900_000n, usuarioId });
    expect(manual.comision).toBe(900_000n);
  });

  it("usarTarifario con el tarifario esperado: sale del tarifario (hallazgo 1)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const tarifario = await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);

    const borrador = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: tarifario.id,
      usuarioId,
    });
    expect(borrador.tarifarioId).toBe(tarifario.id);
    expect(borrador.comision).toBe(475_000n);
  });

  it("usarTarifario con otro total que el que vio el revisor (misma versión): 409 y no se genera (hallazgo 6 de la revisión final)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const tarifario = await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);

    // El revisor vio 520.000 (antes de que cambiara la base o un costo espejo);
    // hoy el tarifario da 475.000.
    const error = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: tarifario.id,
      totalTarifarioEsperado: 520_000n,
      usuarioId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as TarifarioNoAplicableError).status).toBe(409);
    expect((error as Error).message).toContain("los valores del tarifario cambiaron mientras revisabas");
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);

    // Con el total que da hoy, sí.
    const borrador = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: tarifario.id,
      totalTarifarioEsperado: 475_000n,
      usuarioId,
    });
    expect(borrador.comision).toBe(475_000n);
  });

  it("usarTarifario sin tarifario vigente: 409 y NO se factura la comisión por defecto (hallazgo 1)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    // Venció ayer: la empresa tiene la función pero hoy no rige ninguno.
    const vencido = await crearTarifarioEnFechas(empresa.id, ITEMS_FIJOS, {
      desde: "2020-01-01",
      hasta: "2020-12-31",
      version: 1,
    });
    const tramiteId = await crearTramite(empresa.id);

    const error = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: vencido.id,
      usuarioId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as TarifarioNoAplicableError).status).toBe(409);
    expect((error as Error).message).toContain("no tiene un tarifario vigente");
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("usarTarifario con otra versión vigente que la que vio el revisor: 409 (hallazgo 1)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const vigente = await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);

    const error = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: "tarifario-que-vio-el-revisor",
      usuarioId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as TarifarioNoAplicableError).status).toBe(409);
    expect((error as Error).message).toContain(`ahora rige ${vigente.nombre} v${vigente.version}`);
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("usarTarifario con un tarifario que solo tiene ítems MANUAL: 409, no 150.000 (hallazgo 1)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const soloManual = await crearTarifarioEnFechas(empresa.id, ITEMS_FIJOS, {
      desde: "2020-01-01",
      hasta: "2999-12-31",
      version: 1,
      disparador: DisparadorTarifa.MANUAL,
    });
    const tramiteId = await crearTramite(empresa.id);

    const propuesta = await propuestaParaTramite(tramiteId);
    expect(propuesta.resultado?.lineas).toEqual([]);
    expect(propuesta.resultado?.manuales.map((m) => m.nombrePublico)).toEqual([
      "Gastos de trámite vitest",
      "Sistematización vitest",
    ]);

    const error = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: soloManual.id,
      usuarioId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as Error).message).toContain("no propone líneas");
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("usarTarifario en una empresa sin la función: 409, no la comisión por defecto", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: false }]);
    const tramiteId = await crearTramite(empresa.id);
    const error = await generarBorrador({ tramiteId, usarTarifario: true, usuarioId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as Error).message).toContain("no tiene habilitado el tarifario propio");
    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("usarTarifario junto con comisión a mano: 422", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);
    const error = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      comision: 150_000n,
      usuarioId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TarifarioNoAplicableError);
    expect((error as TarifarioNoAplicableError).status).toBe(422);
  });

  it("empresa sin la función: sin comisión usa COMISION_LM como siempre", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: false }]);
    const tramiteId = await crearTramite(empresa.id);
    const parametro = await prisma.parametro.findUniqueOrThrow({ where: { clave: "COMISION_LM" } });

    const borrador = await generarBorrador({ tramiteId, usuarioId });

    const db = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borrador.id },
      select: { comision: true, tarifarioId: true },
    });
    expect(db.tarifarioId).toBeNull();
    expect(db.comision).toBe(BigInt(parametro.valor));
  });
});

// ensureBorrador corre al solicitar facturación y al listar borradores: en el
// flujo normal el borrador ya existe antes de que alguien abra el modal. A una
// empresa con tarifario propio nunca le deja la comisión por defecto.
describe("ensureBorrador con tarifario propio (hallazgo 2 de la revisión final)", () => {
  it("empresa con la función y sin tarifario vigente: no crea borrador (no 150.000)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    // La v1 venció; la siguiente sigue en BORRADOR (no cuenta).
    await crearTarifarioEnFechas(empresa.id, ITEMS_FIJOS, { desde: "2020-01-01", hasta: "2020-12-31", version: 1 });
    const tramiteId = await crearTramite(empresa.id);

    await ensureBorrador(tramiteId, usuarioId);

    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("empresa con la función y tarifario de solo ítems MANUAL: no crea borrador (no 150.000)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    await crearTarifarioEnFechas(empresa.id, ITEMS_FIJOS, {
      desde: "2020-01-01",
      hasta: "2999-12-31",
      version: 1,
      disparador: DisparadorTarifa.MANUAL,
    });
    const tramiteId = await crearTramite(empresa.id);

    await ensureBorrador(tramiteId, usuarioId);

    expect(await prisma.borradorFactura.count({ where: { tramiteId } })).toBe(0);
  });

  it("empresa con la función y tarifario vigente: el borrador sale del tarifario", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const vigente = await crearTarifarioVigente(empresa.id, ITEMS_FIJOS);
    const tramiteId = await crearTramite(empresa.id);

    await ensureBorrador(tramiteId, usuarioId);

    const borrador = await prisma.borradorFactura.findFirstOrThrow({
      where: { tramiteId },
      select: { tarifarioId: true, comision: true },
    });
    expect(borrador.tarifarioId).toBe(vigente.id);
    expect(borrador.comision).toBe(475_000n);
  });

  it("empresa sin la función: sigue creando el borrador con COMISION_LM como siempre", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: false }]);
    const tramiteId = await crearTramite(empresa.id);
    const parametro = await prisma.parametro.findUniqueOrThrow({ where: { clave: "COMISION_LM" } });

    await ensureBorrador(tramiteId, usuarioId);

    const borrador = await prisma.borradorFactura.findFirstOrThrow({
      where: { tramiteId },
      select: { tarifarioId: true, comision: true },
    });
    expect(borrador.tarifarioId).toBeNull();
    expect(borrador.comision).toBe(BigInt(parametro.valor));
  });
});

describe("tarifario vigente según el día calendario en Bogotá (hallazgo 2)", () => {
  // v1 vence el 30-sep; v2 rige desde el 1-oct (días calendario).
  // 2026-10-01T00:30Z = 30-sep 19:30 en Bogotá → todavía rige v1.
  // 2026-10-01T05:30Z = 1-oct 00:30 en Bogotá → ya rige v2.
  const A_LAS_1930_DEL_ULTIMO_DIA = new Date("2026-10-01T00:30:00.000Z");
  const A_LAS_0030_DEL_DIA_SIGUIENTE = new Date("2026-10-01T05:30:00.000Z");
  const ITEMS_V2: ItemFixture[] = [
    { concepto: GT, nombrePublico: "Gastos de trámite vitest", tipoCalculo: TipoCalculoTarifa.FIJO, valor: 400_000n },
  ];

  afterEach(() => {
    vi.useRealTimers();
  });

  async function escenario() {
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const v1 = await crearTarifarioEnFechas(empresa.id, ITEMS_FIJOS, {
      desde: "2026-01-01",
      hasta: "2026-09-30",
      version: 1,
    });
    const v2 = await crearTarifarioEnFechas(empresa.id, ITEMS_V2, {
      desde: "2026-10-01",
      hasta: "2027-09-30",
      version: 2,
    });
    const tramiteId = await crearTramite(empresa.id);
    return { v1, v2, tramiteId };
  }

  function congelarReloj(instante: Date) {
    // Solo Date: Prisma y los timers siguen funcionando.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instante);
  }

  it("propuestaParaTramite sin fecha: a las 19:30 del último día sigue la versión que vence", async (ctx) => {
    ensureDb(ctx);
    const { v1, tramiteId } = await escenario();
    congelarReloj(A_LAS_1930_DEL_ULTIMO_DIA);
    const propuesta = await propuestaParaTramite(tramiteId);
    expect(propuesta.tarifario?.id).toBe(v1.id);
  });

  it("propuestaParaTramite sin fecha: pasada la medianoche de Bogotá, la versión nueva", async (ctx) => {
    ensureDb(ctx);
    const { v2, tramiteId } = await escenario();
    congelarReloj(A_LAS_0030_DEL_DIA_SIGUIENTE);
    const propuesta = await propuestaParaTramite(tramiteId);
    expect(propuesta.tarifario?.id).toBe(v2.id);
  });

  it("generarBorrador (modal, usarTarifario) a las 19:30 del último día factura con la versión que vence", async (ctx) => {
    ensureDb(ctx);
    const { v1, tramiteId } = await escenario();
    congelarReloj(A_LAS_1930_DEL_ULTIMO_DIA);
    const borrador = await generarBorrador({
      tramiteId,
      usarTarifario: true,
      tarifarioIdEsperado: v1.id,
      usuarioId,
    });
    expect(borrador.tarifarioId).toBe(v1.id);
    expect(borrador.comision).toBe(475_000n);
  });

  it("ensureBorrador a las 19:30 del último día usa el tarifario, no la comisión por defecto", async (ctx) => {
    ensureDb(ctx);
    const { v1, tramiteId } = await escenario();
    congelarReloj(A_LAS_1930_DEL_ULTIMO_DIA);
    await ensureBorrador(tramiteId, usuarioId);
    const borrador = await prisma.borradorFactura.findFirstOrThrow({
      where: { tramiteId },
      select: { tarifarioId: true, comision: true },
    });
    expect(borrador.tarifarioId).toBe(v1.id);
    expect(borrador.comision).toBe(475_000n);
  });

  it("generarBorrador sin flag, pasada la medianoche de Bogotá, usa la versión nueva", async (ctx) => {
    ensureDb(ctx);
    const { v2, tramiteId } = await escenario();
    congelarReloj(A_LAS_0030_DEL_DIA_SIGUIENTE);
    const borrador = await generarBorrador({ tramiteId, usuarioId });
    expect(borrador.tarifarioId).toBe(v2.id);
    expect(borrador.comision).toBe(400_000n);
  });
});
