/**
 * Pisos de consecutivo (`fijarPisoConsecutivo`, lo usa
 * scripts/consecutivos/fijar-piso.ts). Año 2087: ningún otro test lo usa.
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { fijarPisoConsecutivo, PisoConsecutivoInvalidoError } from "@/lib/tramites/pisos";
import { createTramite, estadoContadores } from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-pisos";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 2087;

let adminId = "";
let operativoId = "";
let clienteId = "";
let listo = false;
let motivo: string | null = null;

async function limpiar() {
  const tramites = await prisma.tramiteDO.findMany({ where: { anio: ANIO }, select: { id: true } });
  const ids = tramites.map((t) => t.id);
  const pisos = await prisma.consecutivoPiso.findMany({ where: { anio: ANIO }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ tramiteId: { in: ids } }, { entidadId: { in: [...ids, ...pisos.map((p) => p.id)] } }] },
  });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: ids } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: ids } } });
  await prisma.consecutivoPiso.deleteMany({ where: { anio: ANIO } });
  await prisma.cliente.deleteMany({ where: { nit: { startsWith: TEST_PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { usuario: { email: { startsWith: TEST_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivo = "DATABASE_URL no definida";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    if ((await prisma.servicioTramite.count()) === 0) {
      motivo = "La BD no tiene las migraciones del 30-sep-2026";
      return;
    }
  } catch (error) {
    motivo = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  await limpiar();
  adminId = (await prisma.user.create({ data: { email: `${RUN_ID}-a@example.test`, name: "Admin pisos", rol: Rol.ADMIN } })).id;
  operativoId = (await prisma.user.create({ data: { email: `${RUN_ID}-o@example.test`, name: "Operativo pisos", rol: Rol.OPERATIVO } })).id;
  clienteId = (
    await prisma.cliente.create({
      data: {
        nombre: "Cliente vitest pisos",
        nit: `${RUN_ID}-nit`,
        tipo: TipoCliente.PROPIO,
        capacidades: {
          create: [
            { codigo: "do_exige_tarifa_vigente", habilitado: false },
            { codigo: "docs_bl_factura_obligatorios", habilitado: false },
          ],
        },
      },
    })
  ).id;
  listo = true;
});

afterAll(async () => {
  if (listo) await limpiar();
  await prisma.$disconnect();
});

function ensureDb(ctx: { skip: (nota?: string) => void }) {
  if (!listo) ctx.skip(motivo ?? "BD no disponible");
}

const base = {
  tipoTramiteCodigo: "IMPORTACION",
  anio: ANIO,
  motivo: "Camila abrió DOs fuera de la plataforma (duda 3)",
};

describe("fijarPisoConsecutivo", () => {
  it("simulacro: calcula la clave del grupo y el siguiente, sin escribir", async (ctx) => {
    ensureDb(ctx);
    const r = await fijarPisoConsecutivo({ ...base, ciudad: Ciudad.BGT, ultimoNumero: 290, usuarioId: adminId, aplicar: false });
    expect(r).toMatchObject({
      clave: `IMPORTACION:BAQ+BGT+BUN:${ANIO}`,
      siguienteAntes: "DO.BGT87-0001",
      siguienteDespues: "DO.BGT87-0291",
      aplicado: false,
    });
    expect(await prisma.consecutivoPiso.count({ where: { anio: ANIO } })).toBe(0);
  });

  it("aplicar: deja el piso con AuditLog y el próximo DO del grupo toma 0291", async (ctx) => {
    ensureDb(ctx);
    const r = await fijarPisoConsecutivo({ ...base, ciudad: Ciudad.BUN, ultimoNumero: 290, usuarioId: adminId, aplicar: true });
    expect(r.aplicado).toBe(true);
    const log = await prisma.auditLog.findFirst({ where: { entidadId: r.pisoId!, accion: "FIJAR_PISO_CONSECUTIVO" } });
    expect(log?.usuarioId).toBe(adminId);

    const t = await createTramite({
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
    });
    expect(t.consecutivo).toBe("DO.BAQ87-0291");

    const contadores = await estadoContadores(ANIO);
    expect(contadores.find((c) => c.clave === `IMPORTACION:BAQ+BGT+BUN:${ANIO}`)).toMatchObject({
      ultimo: 291,
      piso: 290,
      siguiente: "DO.BAQ87-0292",
    });
  });

  it("rechaza un piso que no cambia nada, un motivo corto, la ciudad faltante y un usuario que no es ADMIN", async (ctx) => {
    ensureDb(ctx);
    await expect(
      fijarPisoConsecutivo({ ...base, ciudad: Ciudad.BAQ, ultimoNumero: 291, usuarioId: adminId, aplicar: true }),
    ).rejects.toBeInstanceOf(PisoConsecutivoInvalidoError);
    await expect(
      fijarPisoConsecutivo({ ...base, motivo: "corto", ciudad: Ciudad.BAQ, ultimoNumero: 400, usuarioId: adminId, aplicar: false }),
    ).rejects.toThrow(/al menos 10 caracteres/);
    await expect(
      fijarPisoConsecutivo({ ...base, ciudad: null, ultimoNumero: 400, usuarioId: adminId, aplicar: false }),
    ).rejects.toThrow(/indica la ciudad/);
    await expect(
      fijarPisoConsecutivo({ ...base, ciudad: Ciudad.BAQ, ultimoNumero: 400, usuarioId: operativoId, aplicar: false }),
    ).rejects.toThrow(/Solo un usuario ADMIN/);
    // Exportación va por año: no pide ciudad.
    const exp = await fijarPisoConsecutivo({
      ...base,
      tipoTramiteCodigo: "EXPORTACION",
      ultimoNumero: 12,
      usuarioId: adminId,
      aplicar: false,
    });
    expect(exp).toMatchObject({ clave: `EXPORTACION:${ANIO}`, siguienteDespues: "DO.EXP87-0013" });
  });
});
