/**
 * Numeración como Camila, con Postgres (DISENO-NUMERACION.md §2.1 y §8,
 * casos 4–9; decisión de Ernesto 30-sep-2026):
 *   - Barranquilla, Bogotá y Buenaventura comparten UN contador; Cartagena el suyo.
 *   - Exportación: serie DO.EXP sin ciudad, con piso; desde la confirmación de
 *     Camila (30-sep-2026) va por ciudad como la importación (detalle en
 *     `exportacion-por-ciudad.integration.test.ts`).
 *   - Un piso sube el punto de partida de un contador.
 *   - El servicio nunca entra en el contador.
 *
 * Años 2081–2085: ningún otro archivo de tests usa esos años. Sin
 * DATABASE_URL (o sin la BD) los tests salen «skipped».
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { createTramite, verificarServicioDelDo } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-numeracion";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIOS = [2081, 2082, 2083, 2084, 2085];
const [ANIO_GRUPO, ANIO_EXPORTACION, ANIO_PISO, ANIO_SERVICIO, ANIO_CONCURRENCIA] = ANIOS;

const SIN_REQUISITOS_DO = [
  { codigo: "do_exige_tarifa_vigente", habilitado: false },
  { codigo: "docs_bl_factura_obligatorios", habilitado: false },
];

type Fixture = { clienteId: string; userId: string };
let fixture: Fixture | null = null;
let motivoSinBd: string | null = null;

async function limpiar() {
  const tramites = await prisma.tramiteDO.findMany({
    where: { OR: [{ anio: { in: ANIOS } }, { comentarios: { startsWith: TEST_PREFIX } }] },
    select: { id: true },
  });
  const ids = tramites.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ tramiteId: { in: ids } }, { entidadId: { in: ids } }] } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: ids } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: ids } } });
  await prisma.consecutivoPiso.deleteMany({ where: { anio: { in: ANIOS } } });
  const usuarios = await prisma.user.findMany({ where: { email: { startsWith: TEST_PREFIX } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: usuarios.map((u) => u.id) } } });
  await prisma.cliente.deleteMany({ where: { nit: { startsWith: TEST_PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

function db(ctx: { skip: (nota?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(motivoSinBd ?? "BD local no disponible");
    throw new Error("omitido");
  }
  return fixture;
}

/** Un DO ya existente (como los que dejó Camila) con número fijo. */
async function existente(f: Fixture, tipo: string, ciudad: Ciudad, anio: number, numero: number, prefijo = "DO") {
  const yy = String(anio).slice(-2);
  const consecutivo =
    tipo === "EXPORTACION"
      ? `DO.EXP${yy}-${String(numero).padStart(4, "0")}`
      : `${prefijo}.${ciudad}${yy}-${String(numero).padStart(4, "0")}`;
  return prisma.tramiteDO.create({
    data: {
      consecutivo,
      tipoTramiteCodigo: tipo,
      ciudad,
      anio,
      numero,
      clienteId: f.clienteId,
      creadoPorId: f.userId,
      comentarios: `${TEST_PREFIX}:${runId}:existente`,
    },
  });
}

function crear(f: Fixture, ciudad: Ciudad, anio: number, extra: Partial<Parameters<typeof createTramite>[0]> = {}) {
  return createTramite({
    ciudad,
    anio,
    clienteId: f.clienteId,
    agenciaAduanas: AgenciaAduanas.COLDEX,
    creadoPorId: f.userId,
    comentarios: `${TEST_PREFIX}:${runId}`,
    ...extra,
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivoSinBd = "DATABASE_URL no definida";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    const servicios = await prisma.servicioTramite.count();
    if (servicios === 0) {
      motivoSinBd = "La BD no tiene las migraciones del 30-sep-2026 (servicio_tramite vacío)";
      return;
    }
    await limpiar();
    const user = await prisma.user.create({
      data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest Numeración", rol: Rol.ADMIN },
    });
    const cliente = await prisma.cliente.create({
      data: {
        nombre: "Cliente Vitest Numeración",
        nit: `${runId}-nit`,
        tipo: TipoCliente.PROPIO,
        capacidades: { create: SIN_REQUISITOS_DO },
      },
    });
    fixture = { clienteId: cliente.id, userId: user.id };
  } catch (error) {
    motivoSinBd = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
  }
});

afterAll(async () => {
  if (fixture) await limpiar();
  await prisma.$disconnect();
});

describe("contador compartido Barranquilla-Bogotá-Buenaventura (casos 4, 5)", () => {
  it("caso 4 — con BAQ 281, BGT 277 y BUN 241: BGT → 0282, BUN → 0283, BAQ nacionalización → 0284", async (ctx) => {
    const f = db(ctx);
    await existente(f, "IMPORTACION", Ciudad.BAQ, ANIO_GRUPO, 281);
    await existente(f, "IMPORTACION", Ciudad.BGT, ANIO_GRUPO, 277);
    await existente(f, "IMPORTACION", Ciudad.BUN, ANIO_GRUPO, 241);

    const bgt = await crear(f, Ciudad.BGT, ANIO_GRUPO);
    const bun = await crear(f, Ciudad.BUN, ANIO_GRUPO);
    const nac = await crear(f, Ciudad.BAQ, ANIO_GRUPO, { conceptoServicioCodigo: "NACIONALIZACION_ZF" });

    expect(bgt.consecutivo).toBe("DO.BGT81-0282");
    expect(bun.consecutivo).toBe("DO.BUN81-0283");
    expect(nac.consecutivo).toBe("DO.BAQ81-0284");
    expect(nac.conceptoServicioCodigo).toBe("NACIONALIZACION_ZF");
    // Importación general: sin concepto, como todos los DOs de siempre.
    expect(bgt.conceptoServicioCodigo).toBeNull();
  });

  it("caso 5 — Cartagena no se mueve con el grupo: CTG 250 → DUTA 0251, luego importación 0252", async (ctx) => {
    const f = db(ctx);
    await existente(f, "IMPORTACION", Ciudad.CTG, ANIO_GRUPO, 250);

    const duta = await crear(f, Ciudad.CTG, ANIO_GRUPO, { conceptoServicioCodigo: "DUTA" });
    const imp = await crear(f, Ciudad.CTG, ANIO_GRUPO);
    const smr = await crear(f, Ciudad.SMR, ANIO_GRUPO);

    expect(duta.consecutivo).toBe("DO.CTG81-0251");
    expect(duta.conceptoServicioCodigo).toBe("DUTA");
    expect(imp.consecutivo).toBe("DO.CTG81-0252");
    // Santa Marta lleva el suyo (duda 2 para Camila).
    expect(smr.consecutivo).toBe("DO.SMR81-0001");
  });
});

describe("Exportación y pisos (casos 6, 7)", () => {
  it("caso 6 — Exportación sin filas y piso 12 del grupo → DO.EXP82-0013, Bogotá 0014; Cartagena aparte; un piso menor no cambia nada", async (ctx) => {
    const f = db(ctx);
    await prisma.consecutivoPiso.create({
      data: {
        clave: `EXPORTACION:BAQ+BGT+BUN:${ANIO_EXPORTACION}`,
        tipoTramiteCodigo: "EXPORTACION",
        anio: ANIO_EXPORTACION,
        ultimoNumero: 12,
        motivo: "Prueba: DO.EXP 0001 a 0012 fuera del tipo",
      },
    });

    const primera = await crear(f, Ciudad.BAQ, ANIO_EXPORTACION, {
      tipoTramiteCodigo: "EXPORTACION",
      agenciaAduanas: undefined,
    });
    const segunda = await crear(f, Ciudad.BGT, ANIO_EXPORTACION, {
      tipoTramiteCodigo: "EXPORTACION",
      agenciaAduanas: undefined,
    });
    const cartagena = await crear(f, Ciudad.CTG, ANIO_EXPORTACION, {
      tipoTramiteCodigo: "EXPORTACION",
      agenciaAduanas: undefined,
    });
    expect(primera.consecutivo).toBe("DO.EXP82-0013");
    expect(segunda.consecutivo).toBe("DO.EXP82-0014");
    // Cartagena lleva su propio contador: el piso del grupo no la toca.
    expect(cartagena.consecutivo).toBe("DO.EXP.CTG82-0001");
    // El servicio de la exportación se escoge solo.
    expect(primera.conceptoServicioCodigo).toBe("EXPORTACION");
    // Sin agencia ni checklist (flujo corto, como «Otros»).
    expect(primera.agenciaAduanas).toBeNull();
    expect(primera.checklistItems).toEqual([]);

    await prisma.consecutivoPiso.create({
      data: {
        clave: `EXPORTACION:BAQ+BGT+BUN:${ANIO_EXPORTACION}`,
        tipoTramiteCodigo: "EXPORTACION",
        anio: ANIO_EXPORTACION,
        ultimoNumero: 5,
        motivo: "Prueba: piso menor que el máximo",
      },
    });
    const tercera = await crear(f, Ciudad.BUN, ANIO_EXPORTACION, {
      tipoTramiteCodigo: "EXPORTACION",
      agenciaAduanas: undefined,
    });
    expect(tercera.consecutivo).toBe("DO.EXP82-0015");
  });

  it("caso 7 — piso del grupo = 300 → la siguiente de cualquiera de las tres es 0301", async (ctx) => {
    const f = db(ctx);
    await existente(f, "IMPORTACION", Ciudad.BAQ, ANIO_PISO, 120);
    await prisma.consecutivoPiso.create({
      data: {
        clave: `IMPORTACION:BAQ+BGT+BUN:${ANIO_PISO}`,
        tipoTramiteCodigo: "IMPORTACION",
        anio: ANIO_PISO,
        ultimoNumero: 300,
        motivo: "Prueba: último número de Camila fuera de la plataforma",
      },
    });

    const bun = await crear(f, Ciudad.BUN, ANIO_PISO);
    const baq = await crear(f, Ciudad.BAQ, ANIO_PISO);
    const ctg = await crear(f, Ciudad.CTG, ANIO_PISO);
    expect(bun.consecutivo).toBe("DO.BUN83-0301");
    expect(baq.consecutivo).toBe("DO.BAQ83-0302");
    // El piso del grupo no toca a Cartagena.
    expect(ctg.consecutivo).toBe("DO.CTG83-0001");
  });
});

describe("el servicio no entra en el contador (caso 8)", () => {
  it("caso 8 — cambiar el servicio de un DO no cambia su número ni su ciudad", async (ctx) => {
    const f = db(ctx);
    const doBaq = await crear(f, Ciudad.BAQ, ANIO_SERVICIO);
    expect(doBaq.consecutivo).toBe("DO.BAQ84-0001");

    const verificado = await verificarServicioDelDo({
      tipoTramiteCodigo: "IMPORTACION",
      tramiteId: doBaq.id,
      estadoActual: doBaq.estado,
      antes: { valorServicio: null, conceptoServicioCodigo: null },
      conceptoServicioCodigo: "TRASLADO_ZF",
      clienteId: f.clienteId,
      ciudad: doBaq.ciudad,
    });
    expect(verificado?.conceptoServicioCodigo).toBe("TRASLADO_ZF");
    await prisma.tramiteDO.update({
      where: { id: doBaq.id },
      data: { conceptoServicioCodigo: verificado?.conceptoServicioCodigo },
    });

    const despues = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: doBaq.id } });
    expect(despues).toMatchObject({
      consecutivo: "DO.BAQ84-0001",
      numero: 1,
      ciudad: Ciudad.BAQ,
      conceptoServicioCodigo: "TRASLADO_ZF",
    });

    // El siguiente del grupo no se entera del servicio: 0002.
    const siguiente = await crear(f, Ciudad.BGT, ANIO_SERVICIO, { conceptoServicioCodigo: "DUTA" });
    expect(siguiente.consecutivo).toBe("DO.BGT84-0002");
  });
});

describe("concurrencia (caso 9)", () => {
  it("caso 9 — 20 creaciones a la vez entre BAQ, BGT y BUN (con y sin servicio) → 20 números distintos y seguidos", async (ctx) => {
    const f = db(ctx);
    const ciudades = [Ciudad.BAQ, Ciudad.BGT, Ciudad.BUN];
    const servicios = [undefined, "TRASLADO_ZF", "NACIONALIZACION_ZF", "DUTA"];

    const creados = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        crear(f, ciudades[i % 3], ANIO_CONCURRENCIA, {
          conceptoServicioCodigo: servicios[i % 4],
          comentarios: `${TEST_PREFIX}:${runId}:concurrencia:${i}`,
        }),
      ),
    );

    const numeros = creados.map((t) => t.numero).sort((a, b) => a - b);
    expect(new Set(numeros).size).toBe(20);
    expect(numeros).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const t of creados) {
      expect(t.consecutivo).toBe(`DO.${t.ciudad}85-${String(t.numero).padStart(4, "0")}`);
    }
  });
});
