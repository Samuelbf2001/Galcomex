/**
 * Diseño A (27-sep-2026) — B3, tarifario por ciudad, visto desde `tramites/service.ts`
 * (R1 y R5: quién pasa la ciudad y qué hace `createTramite`/`requisitosDeDo`
 * con ella). Mismo patrón de `requisitos.integration.test.ts`: se omite sin BD.
 *
 * TEST_PREFIX único: "vitest-diseno-a-ciudad"
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTarifario, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { createTramite, requisitosDeDo, TarifaVigenteRequeridaError } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-diseno-a-ciudad";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 2097;
const DIA = 86_400_000;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresasCreadas = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
  }
}

async function crearEmpresa() {
  empresasCreadas += 1;
  return prisma.cliente.create({
    data: {
      nombre: `EMPRESA VITEST DISEÑO A CIUDAD ${empresasCreadas}`,
      nit: `${RUN_ID}-${empresasCreadas}`,
      tipo: TipoCliente.PROPIO,
      // D1 exige tarifa vigente por defecto para IMPORTACION: se deja así a
      // propósito, es justo lo que este archivo prueba.
    },
  });
}

async function crearTarifarioCiudad(
  empresaId: string,
  opciones: {
    ciudades?: Ciudad[];
    alcance?: string;
    estado?: EstadoTarifario;
    desde?: Date;
    hasta?: Date;
    version?: number;
  } = {},
) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: `Tarifa vitest ${opciones.ciudades?.join("+") ?? "general"}`,
      alcance: opciones.alcance ?? "TRAMITE",
      ciudades: opciones.ciudades ?? [],
      estado: opciones.estado ?? EstadoTarifario.VIGENTE,
      vigenteDesde: opciones.desde ?? new Date(Date.now() - 30 * DIA),
      vigenteHasta: opciones.hasta ?? new Date(Date.now() + 30 * DIA),
      version: opciones.version ?? 1,
      creadoPorId: usuarioId,
    },
  });
}

function datosDo(clienteId: string, ciudad: Ciudad) {
  return {
    ciudad,
    anio: ANIO,
    clienteId,
    tipoTramiteCodigo: "IMPORTACION",
    agenciaAduanas: AgenciaAduanas.COLDEX,
    creadoPorId: usuarioId,
    comentarios: `${TEST_PREFIX}:${RUN_ID}`,
  };
}

async function limpiar() {
  const empresas = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const empresaIds = empresas.map((e) => e.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: empresaIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);

  await prisma.auditLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: empresaIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: empresaIds } } });
  await prisma.auditLog.deleteMany({ where: { usuario: { email: { startsWith: TEST_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de Diseño A (ciudad)";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    dbUnavailableReason = `BD local Postgres no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  dbConnected = true;
  await limpiar();
  const user = await prisma.user.create({
    data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest Diseño A Ciudad" },
  });
  usuarioId = user.id;
});

afterAll(async () => {
  if (dbConnected) await limpiar();
});

describe("B3 — createTramite usa el tarifario de la ciudad del DO", () => {
  it("ciudad sin tarifario propio: usa el general (comportamiento de siempre)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifarioCiudad(empresa.id, { ciudades: [] });

    const tramite = await createTramite(datosDo(empresa.id, Ciudad.CTG));
    expect(tramite.id).toBeTruthy();
  });

  it("ciudad CON tarifario propio vigente: se crea sin problema", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifarioCiudad(empresa.id, { ciudades: [] });
    await crearTarifarioCiudad(empresa.id, { ciudades: [Ciudad.BGT], version: 2 });

    const tramite = await createTramite(datosDo(empresa.id, Ciudad.BGT));
    expect(tramite.id).toBeTruthy();
  });

  it("ciudad con tarifario propio FUERA DE FECHA nunca cae al general en silencio", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    // General vigente y en fecha: si B3 estuviera mal, el DO de Bogotá se
    // colaría usando estos precios.
    await crearTarifarioCiudad(empresa.id, { ciudades: [] });
    // Bogotá tiene tarifario propio, pero ya venció.
    await crearTarifarioCiudad(empresa.id, {
      ciudades: [Ciudad.BGT],
      version: 2,
      desde: new Date(Date.now() - 60 * DIA),
      hasta: new Date(Date.now() - 30 * DIA),
    });

    await expect(createTramite(datosDo(empresa.id, Ciudad.BGT))).rejects.toBeInstanceOf(
      TarifaVigenteRequeridaError,
    );
  });
});

describe("B3 — requisitosDeDo con ciudad", () => {
  it("sin tarifario propio de la ciudad: cumple con el general", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifarioCiudad(empresa.id, { ciudades: [] });

    const requisitos = await requisitosDeDo({ clienteId: empresa.id, ciudad: Ciudad.SMR });
    expect(requisitos.tarifaVigente.cumple).toBe(true);
  });

  it("ciudad con tarifario propio fuera de fecha: no cumple y el mensaje la menciona", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifarioCiudad(empresa.id, { ciudades: [] });
    await crearTarifarioCiudad(empresa.id, {
      ciudades: [Ciudad.BGT],
      version: 2,
      desde: new Date(Date.now() - 60 * DIA),
      hasta: new Date(Date.now() - 30 * DIA),
    });

    const requisitos = await requisitosDeDo({ clienteId: empresa.id, ciudad: Ciudad.BGT });
    expect(requisitos.tarifaVigente.cumple).toBe(false);
    expect(requisitos.tarifaVigente.tarifario).toBeNull();
    expect(requisitos.tarifaVigente.mensaje).toMatch(/venció/);
  });
});
