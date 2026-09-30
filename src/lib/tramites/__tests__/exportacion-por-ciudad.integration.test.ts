/**
 * Exportación por ciudad, con Postgres (decisión de Ernesto confirmada por
 * María Camila, 30-sep-2026). Los cinco contadores de Camila:
 *   1. Importación Barranquilla + Bogotá + Buenaventura juntos
 *   2. Exportación Barranquilla (+ Bogotá y Buenaventura: supuesto nuestro)
 *   3. Importación Cartagena aparte
 *   4. Exportación Cartagena aparte (DO.EXP.CTG, provisional)
 *   5. Importación Santa Marta aparte
 *   (+ Exportación Santa Marta aparte: supuesto nuestro, DO.EXP.SMR)
 * Más: el caso borde de una exportación de Cartagena numerada con la serie
 * vieja, concurrencia y la configuración que repetiría números.
 *
 * Necesita la migración 20260930120000 (Exportación por ciudad). Años
 * 2088–2091: ningún otro archivo de tests los usa. Sin DATABASE_URL (o sin la
 * BD) los tests salen «skipped».
 */
import "dotenv/config";

import { Ciudad, Prisma, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  createTramite,
  estadoContadores,
  NumeracionMalConfiguradaError,
  requisitosDeDo,
} from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-expo-ciudad";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIOS = [2088, 2089, 2090, 2091];
const [ANIO_CINCO, ANIO_BORDE, ANIO_CONCURRENCIA, ANIO_CONFIG] = ANIOS;

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

/** Un DO ya existente con número y texto fijos (como los que dejó Camila). */
async function existente(f: Fixture, tipo: string, ciudad: Ciudad, anio: number, numero: number, consecutivo: string) {
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

function importacion(f: Fixture, ciudad: Ciudad, anio: number) {
  return createTramite({
    ciudad,
    anio,
    clienteId: f.clienteId,
    agenciaAduanas: "COLDEX",
    creadoPorId: f.userId,
    comentarios: `${TEST_PREFIX}:${runId}`,
  });
}

function exportacion(f: Fixture, ciudad: Ciudad, anio: number, comentario = "") {
  return createTramite({
    ciudad,
    anio,
    clienteId: f.clienteId,
    tipoTramiteCodigo: "EXPORTACION",
    creadoPorId: f.userId,
    comentarios: `${TEST_PREFIX}:${runId}${comentario}`,
  });
}

function pisoGrupoExportacion(anio: number, ultimoNumero: number) {
  return prisma.consecutivoPiso.create({
    data: {
      clave: `EXPORTACION:BAQ+BGT+BUN:${anio}`,
      tipoTramiteCodigo: "EXPORTACION",
      anio,
      ultimoNumero,
      motivo: "Prueba: DO.EXP 0001 a 0012 de Barranquilla fuera del tipo",
    },
  });
}

/** Cambia la configuración de Exportación mientras corre `fn` y la devuelve como estaba. */
async function conConfigExportacion(
  cambio: { ciudadesContadorComun?: Ciudad[]; prefijoConsecutivoPorCiudad?: Prisma.InputJsonValue },
  fn: () => Promise<void>,
) {
  const antes = await prisma.tipoTramite.findUniqueOrThrow({
    where: { codigo: "EXPORTACION" },
    select: { ciudadesContadorComun: true, prefijoConsecutivoPorCiudad: true },
  });
  await prisma.tipoTramite.update({ where: { codigo: "EXPORTACION" }, data: cambio });
  try {
    await fn();
  } finally {
    await prisma.tipoTramite.update({
      where: { codigo: "EXPORTACION" },
      data: {
        ciudadesContadorComun: antes.ciudadesContadorComun,
        prefijoConsecutivoPorCiudad: (antes.prefijoConsecutivoPorCiudad ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivoSinBd = "DATABASE_URL no definida";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    const exportacionTipo = await prisma.tipoTramite.findUnique({ where: { codigo: "EXPORTACION" } });
    if (!exportacionTipo || exportacionTipo.secuenciaPor !== "CIUDAD_ANIO") {
      motivoSinBd = "La BD no tiene la migración 20260930120000 (Exportación por ciudad)";
      return;
    }
    await limpiar();
    const user = await prisma.user.create({
      data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest Exportación por ciudad", rol: Rol.ADMIN },
    });
    const cliente = await prisma.cliente.create({
      data: {
        nombre: "Cliente Vitest Exportación por ciudad",
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

describe("los cinco contadores de Camila en el mismo año", () => {
  it("importación y exportación, por ciudad, sin mezclarse", async (ctx) => {
    const f = db(ctx);
    // Lo que ya existe (como en producción el 30-sep-2026).
    await existente(f, "IMPORTACION", Ciudad.BAQ, ANIO_CINCO, 281, "DO.BAQ88-0281");
    await existente(f, "IMPORTACION", Ciudad.BGT, ANIO_CINCO, 277, "DO.BGT88-0277");
    await existente(f, "IMPORTACION", Ciudad.BUN, ANIO_CINCO, 241, "DO.BUN88-0241");
    await existente(f, "IMPORTACION", Ciudad.CTG, ANIO_CINCO, 250, "DO.CTG88-0250");
    await existente(f, "IMPORTACION", Ciudad.SMR, ANIO_CINCO, 1, "DO.SMR88-0001");
    await pisoGrupoExportacion(ANIO_CINCO, 12);

    // 1. Importación BAQ + BGT + BUN, un solo contador.
    expect((await importacion(f, Ciudad.BGT, ANIO_CINCO)).consecutivo).toBe("DO.BGT88-0282");
    // 2. Exportación Barranquilla, y Bogotá y Buenaventura con ella.
    const expBaq = await exportacion(f, Ciudad.BAQ, ANIO_CINCO);
    expect(expBaq.consecutivo).toBe("DO.EXP88-0013");
    expect(expBaq.conceptoServicioCodigo).toBe("EXPORTACION");
    expect((await exportacion(f, Ciudad.BGT, ANIO_CINCO)).consecutivo).toBe("DO.EXP88-0014");
    expect((await exportacion(f, Ciudad.BUN, ANIO_CINCO)).consecutivo).toBe("DO.EXP88-0015");
    // 3. Importación Cartagena aparte.
    expect((await importacion(f, Ciudad.CTG, ANIO_CINCO)).consecutivo).toBe("DO.CTG88-0251");
    // 4. Exportación Cartagena aparte (no empieza en 13: el piso es del grupo).
    expect((await exportacion(f, Ciudad.CTG, ANIO_CINCO)).consecutivo).toBe("DO.EXP.CTG88-0001");
    // 5. Importación Santa Marta aparte.
    expect((await importacion(f, Ciudad.SMR, ANIO_CINCO)).consecutivo).toBe("DO.SMR88-0002");
    // Exportación Santa Marta aparte (supuesto nuestro).
    expect((await exportacion(f, Ciudad.SMR, ANIO_CINCO)).consecutivo).toBe("DO.EXP.SMR88-0001");
    // Cada uno sigue su propia cuenta.
    expect((await exportacion(f, Ciudad.CTG, ANIO_CINCO)).consecutivo).toBe("DO.EXP.CTG88-0002");
    expect((await importacion(f, Ciudad.BAQ, ANIO_CINCO)).consecutivo).toBe("DO.BAQ88-0283");
    expect((await exportacion(f, Ciudad.BAQ, ANIO_CINCO)).consecutivo).toBe("DO.EXP88-0016");

    const contadores = await estadoContadores(ANIO_CINCO);
    const fila = (clave: string) => contadores.find((c) => c.clave === clave);
    expect(fila(`IMPORTACION:BAQ+BGT+BUN:${ANIO_CINCO}`)).toMatchObject({
      contador: "contador compartido Barranquilla, Bogotá y Buenaventura",
      ultimo: 283,
      siguiente: "DO.BAQ88-0284",
      problema: null,
    });
    expect(fila(`IMPORTACION:CTG:${ANIO_CINCO}`)).toMatchObject({ contador: "contador de Cartagena", siguiente: "DO.CTG88-0252" });
    expect(fila(`IMPORTACION:SMR:${ANIO_CINCO}`)).toMatchObject({ siguiente: "DO.SMR88-0003" });
    expect(fila(`EXPORTACION:BAQ+BGT+BUN:${ANIO_CINCO}`)).toMatchObject({
      contador: "contador de exportación Barranquilla, Bogotá y Buenaventura",
      ultimo: 16,
      piso: 12,
      siguiente: "DO.EXP88-0017",
      problema: null,
    });
    expect(fila(`EXPORTACION:CTG:${ANIO_CINCO}`)).toMatchObject({
      contador: "contador de exportación de Cartagena",
      ultimo: 2,
      siguiente: "DO.EXP.CTG88-0003",
    });
    expect(fila(`EXPORTACION:SMR:${ANIO_CINCO}`)).toMatchObject({
      contador: "contador de exportación de Santa Marta",
      siguiente: "DO.EXP.SMR88-0002",
    });
    // Exportación: exactamente tres contadores (no uno por ciudad para BGT y BUN).
    expect(contadores.filter((c) => c.tipoTramiteCodigo === "EXPORTACION").map((c) => c.clave)).toEqual([
      `EXPORTACION:BAQ+BGT+BUN:${ANIO_CINCO}`,
      `EXPORTACION:CTG:${ANIO_CINCO}`,
      `EXPORTACION:SMR:${ANIO_CINCO}`,
    ]);
  });
});

describe("caso borde de la migración", () => {
  it("una exportación de Cartagena numerada con la serie vieja (DO.EXP89-0013) no produce choques", async (ctx) => {
    const f = db(ctx);
    // Antes de la migración el contador era por año: una exportación de
    // Cartagena pudo salir DO.EXP89-0013. La migración deja el piso del grupo
    // en max(12, 13) = 13.
    await existente(f, "EXPORTACION", Ciudad.CTG, ANIO_BORDE, 13, "DO.EXP89-0013");
    await pisoGrupoExportacion(ANIO_BORDE, 13);

    // Barranquilla no repite el 0013 (sin el piso chocaría al llegar ahí).
    expect((await exportacion(f, Ciudad.BAQ, ANIO_BORDE)).consecutivo).toBe("DO.EXP89-0014");
    // Cartagena sigue desde su número más alto, con su propio prefijo: sin choque.
    expect((await exportacion(f, Ciudad.CTG, ANIO_BORDE)).consecutivo).toBe("DO.EXP.CTG89-0014");
    // El DO viejo quedó intacto.
    const viejo = await prisma.tramiteDO.findFirstOrThrow({ where: { consecutivo: "DO.EXP89-0013" } });
    expect(viejo).toMatchObject({ ciudad: Ciudad.CTG, numero: 13, tipoTramiteCodigo: "EXPORTACION" });
  });
});

describe("concurrencia", () => {
  it("12 exportaciones a la vez entre BAQ, BGT, BUN y CTG → grupo 1–9 y Cartagena 1–3, sin repetir", async (ctx) => {
    const f = db(ctx);
    const ciudades = [Ciudad.BAQ, Ciudad.BGT, Ciudad.BUN, Ciudad.CTG];
    const creados = await Promise.all(
      Array.from({ length: 12 }, (_, i) => exportacion(f, ciudades[i % 4], ANIO_CONCURRENCIA, `:concurrencia:${i}`)),
    );

    const grupo = creados.filter((t) => t.ciudad !== Ciudad.CTG);
    const cartagena = creados.filter((t) => t.ciudad === Ciudad.CTG);
    expect(grupo.map((t) => t.numero).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cartagena.map((t) => t.numero).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    for (const t of grupo) expect(t.consecutivo).toBe(`DO.EXP90-${String(t.numero).padStart(4, "0")}`);
    for (const t of cartagena) expect(t.consecutivo).toBe(`DO.EXP.CTG90-${String(t.numero).padStart(4, "0")}`);
    expect(new Set(creados.map((t) => t.consecutivo)).size).toBe(12);
  });
});

describe("configuración que repetiría números (se cambia con datos, sin programar)", () => {
  it("sin prefijo propio de Santa Marta no se numera ninguna exportación; la importación sigue", async (ctx) => {
    const f = db(ctx);
    await conConfigExportacion({ prefijoConsecutivoPorCiudad: { CTG: "DO.EXP.CTG" } }, async () => {
      const error = await exportacion(f, Ciudad.BAQ, ANIO_CONFIG).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NumeracionMalConfiguradaError);
      expect((error as Error).message).toMatch(/SMR/);
      await expect(exportacion(f, Ciudad.CTG, ANIO_CONFIG)).rejects.toBeInstanceOf(NumeracionMalConfiguradaError);
      // La importación no se entera.
      expect((await importacion(f, Ciudad.BAQ, ANIO_CONFIG)).consecutivo).toBe("DO.BAQ91-0001");

      const contadores = await estadoContadores(ANIO_CONFIG);
      expect(contadores.find((c) => c.clave === `EXPORTACION:CTG:${ANIO_CONFIG}`)?.problema).toMatch(/SMR/);
      expect(contadores.find((c) => c.clave === `IMPORTACION:BAQ+BGT+BUN:${ANIO_CONFIG}`)?.problema).toBeNull();

      // La vista previa del formulario tampoco promete un número.
      const previa = await requisitosDeDo({ clienteId: f.clienteId, tipoTramiteCodigo: "EXPORTACION", ciudad: Ciudad.BAQ });
      expect(previa.numeracion).toEqual({
        siguiente: "sin número",
        contador:
          "contador de exportación Barranquilla, Bogotá y Buenaventura: numeración mal configurada, no se puede crear el DO (avísale a soporte)",
      });
    });
    // Ningún número se gastó mientras estuvo mal.
    expect(await prisma.tramiteDO.count({ where: { tipoTramiteCodigo: "EXPORTACION", anio: ANIO_CONFIG } })).toBe(0);
  });

  it("Cartagena con el prefijo de la importación (DO.CTG) frena solo esos dos contadores", async (ctx) => {
    const f = db(ctx);
    await conConfigExportacion({ prefijoConsecutivoPorCiudad: { CTG: "DO.CTG", SMR: "DO.EXP.SMR" } }, async () => {
      await expect(exportacion(f, Ciudad.CTG, ANIO_CONFIG)).rejects.toBeInstanceOf(NumeracionMalConfiguradaError);
      await expect(importacion(f, Ciudad.CTG, ANIO_CONFIG)).rejects.toThrow(/DO\.CTG/);
      // Barranquilla (importación y exportación) sigue.
      expect((await importacion(f, Ciudad.BGT, ANIO_CONFIG)).consecutivo).toBe("DO.BGT91-0002");
      expect((await exportacion(f, Ciudad.BAQ, ANIO_CONFIG)).consecutivo).toBe("DO.EXP91-0001");
    });
  });

  it("Bogotá exporta aparte (si Camila lo dice): basta con cambiar los datos", async (ctx) => {
    const f = db(ctx);
    await conConfigExportacion(
      {
        ciudadesContadorComun: [Ciudad.BAQ, Ciudad.BUN],
        prefijoConsecutivoPorCiudad: { CTG: "DO.EXP.CTG", SMR: "DO.EXP.SMR", BGT: "DO.EXP.BGT" },
      },
      async () => {
        expect((await exportacion(f, Ciudad.BGT, ANIO_CONFIG)).consecutivo).toBe("DO.EXP.BGT91-0001");
        expect((await exportacion(f, Ciudad.BUN, ANIO_CONFIG)).consecutivo).toBe("DO.EXP91-0002");
      },
    );
  });

  it("vista previa del número: usa la ciudad escogida y no la inventa", async (ctx) => {
    const f = db(ctx);
    const conCiudad = await requisitosDeDo({ clienteId: f.clienteId, tipoTramiteCodigo: "EXPORTACION", ciudad: Ciudad.CTG });
    expect(conCiudad.numeracion?.siguiente).toMatch(/^DO\.EXP\.CTG\d{2}-\d{4}$/);
    expect(conCiudad.numeracion?.contador).toBe("contador de exportación de Cartagena");

    const grupo = await requisitosDeDo({ clienteId: f.clienteId, tipoTramiteCodigo: "EXPORTACION", ciudad: Ciudad.BUN });
    expect(grupo.numeracion?.siguiente).toMatch(/^DO\.EXP\d{2}-\d{4}$/);
    expect(grupo.numeracion?.contador).toBe("contador de exportación Barranquilla, Bogotá y Buenaventura");

    const sinCiudad = await requisitosDeDo({ clienteId: f.clienteId, tipoTramiteCodigo: "EXPORTACION" });
    // Sin ciudad no hay número que mostrar (el contrato lo trae opcional).
    expect(sinCiudad.numeracion ?? null).toBeNull();
  });
});
