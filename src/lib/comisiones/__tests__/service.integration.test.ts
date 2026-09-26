import "dotenv/config";

import { AgenciaAduanas, Ciudad, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  comisionesDeEmpresa,
  comisionesDeTramite,
  registrarComisionTramite,
  verificarComisionesAlEditar,
} from "@/lib/comisiones/service";
import { createTramite } from "@/lib/tramites/service";

/**
 * Comisión por contenedor contra Postgres (caso LTRANS, Camila 25-sep): un DO
 * de traslado de Polyrec ZF con 4 contenedores, 2 de LTRANS y 2 de otro
 * transportista que también paga comisión.
 */

const RUN = `vitest-comision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 2097;
const SIN_REQUISITOS_DO = [
  { codigo: "do_exige_tarifa_vigente", habilitado: false },
  { codigo: "docs_bl_factura_obligatorios", habilitado: false },
];

type Fixture = {
  usuarioId: string;
  polyrecZfId: string;
  ltransId: string;
  otroId: string;
  sinFuncionId: string;
};

let fx: Fixture | null = null;
let motivoSinBd: string | null = null;

async function limpiar() {
  const empresas = await prisma.cliente.findMany({ where: { nit: { startsWith: RUN } }, select: { id: true } });
  const ids = empresas.map((e) => e.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: ids } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.comisionTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: `${RUN}@example.test` } });
}

function ensureDb(ctx: { skip: (nota?: string) => void }): Fixture {
  if (!fx) {
    ctx.skip(motivoSinBd ?? "BD local no disponible");
    throw new Error("sin BD");
  }
  return fx;
}

async function crearDo(contenedores: { numContenedores?: number; tipoCarga?: "SUELTA" }) {
  return createTramite({
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId: fx!.polyrecZfId,
    agenciaAduanas: AgenciaAduanas.COLDEX,
    creadoPorId: fx!.usuarioId,
    referenciaExterna: "POLYREC ZF - TRASLADO BL. VITEST",
    ...contenedores,
  });
}

describe("comisión por contenedor (LTRANS) con Postgres", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      motivoSinBd = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const usuario = await prisma.user.create({
        data: { email: `${RUN}@example.test`, emailVerified: true, name: "Vitest Comisión", rol: Rol.OPERATIVO },
      });
      const crear = (nombre: string, sufijo: string, capacidades: { codigo: string; habilitado: boolean; config?: object }[]) =>
        prisma.cliente.create({
          data: { nombre, nit: `${RUN}-${sufijo}`, tipo: TipoCliente.PROPIO, capacidades: { create: capacidades } },
        });
      const polyrecZf = await crear("POLYREC ZF VITEST", "zf", [
        ...SIN_REQUISITOS_DO,
        { codigo: "contenedores_obligatorio", habilitado: true },
      ]);
      const ltrans = await crear("LTRANS VITEST", "ltrans", [
        { codigo: "comision_por_evento", habilitado: true, config: { unidad: "CONTENEDOR", valor: "90000" } },
      ]);
      const otro = await crear("OTRO TRANSPORTE VITEST", "otro", [
        { codigo: "comision_por_evento", habilitado: true, config: { unidad: "CONTENEDOR", valor: "80000" } },
      ]);
      const sinFuncion = await crear("SIN FUNCION VITEST", "sin", []);
      fx = {
        usuarioId: usuario.id,
        polyrecZfId: polyrecZf.id,
        ltransId: ltrans.id,
        otroId: otro.id,
        sinFuncionId: sinFuncion.id,
      };
    } catch (error) {
      motivoSinBd = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (fx) await limpiar();
    await prisma.$disconnect();
  });

  it("de 4 contenedores: 2 de LTRANS y 2 de otro; nunca más de 4 entre los dos", async (ctx) => {
    const f = ensureDb(ctx);
    const tramite = await crearDo({ numContenedores: 4 });
    const registrar = (empresaId: string, unidades: number) =>
      registrarComisionTramite({ tramiteId: tramite.id, empresaId, unidades, usuarioId: f.usuarioId });

    const antes = await comisionesDeTramite(tramite.id);
    expect(antes.aplica).toBe(true);
    expect(antes.unidadesDisponibles).toBe(4);
    expect(antes.empresas.map((e) => e.empresaId)).toEqual(expect.arrayContaining([f.ltransId, f.otroId]));

    await registrar(f.ltransId, 2);
    await expect(registrar(f.otroId, 3)).rejects.toMatchObject({
      name: "ComisionInvalidaError",
      status: 422,
      message: `El ${tramite.consecutivo} solo tiene 2 contenedores disponibles para comisión (4 en total, 2 ya con comisión de otra empresa).`,
    });
    await registrar(f.otroId, 2);
    await expect(registrar(f.ltransId, 3)).rejects.toMatchObject({ name: "ComisionInvalidaError" });

    const despues = await comisionesDeTramite(tramite.id);
    expect(despues.comisiones).toEqual([
      expect.objectContaining({ empresaId: f.ltransId, unidades: 2, valorUnitario: 90_000n, subtotal: 180_000n }),
      expect.objectContaining({ empresaId: f.otroId, unidades: 2, valorUnitario: 80_000n, subtotal: 160_000n }),
    ]);

    // Ficha de LTRANS: solo lo suyo, con IVA exacto.
    const ficha = await comisionesDeEmpresa(f.ltransId);
    expect(ficha.valorUnitario).toBe(90_000n);
    expect(ficha.filas).toEqual([
      expect.objectContaining({ consecutivo: tramite.consecutivo, unidades: 2, numContenedores: 4, subtotal: 180_000n }),
    ]);
    expect(ficha.totales).toEqual({ unidades: 2, subtotal: 180_000n, iva: 34_200n, total: 214_200n });

    // No se puede bajar el DO por debajo de lo comprometido (4 con comisión).
    await expect(verificarComisionesAlEditar(tramite, { numContenedores: 3 })).rejects.toMatchObject({
      name: "ComisionInvalidaError",
      message: `El ${tramite.consecutivo} tiene 4 contenedores con comisión: no puede quedar con menos. Ajusta primero la comisión.`,
    });
    await expect(verificarComisionesAlEditar(tramite, { numContenedores: 5 })).resolves.toBeUndefined();

    // Quitar (unidades = 0) libera los contenedores y queda en el historial.
    await registrar(f.otroId, 0);
    expect((await comisionesDeTramite(tramite.id)).comisiones).toHaveLength(1);
    const auditoria = await prisma.auditLog.findMany({
      where: { tramiteId: tramite.id, entidad: "ComisionTramite" },
      select: { accion: true },
    });
    expect(auditoria.map((a) => a.accion).sort()).toEqual(["CREATE", "CREATE", "DELETE"]);
  });

  it("la carga suelta cuenta como 1 contenedor", async (ctx) => {
    const f = ensureDb(ctx);
    const tramite = await crearDo({ tipoCarga: "SUELTA" });
    const registrar = (unidades: number) =>
      registrarComisionTramite({ tramiteId: tramite.id, empresaId: f.ltransId, unidades, usuarioId: f.usuarioId });

    expect((await comisionesDeTramite(tramite.id)).unidadesDisponibles).toBe(1);
    await expect(registrar(2)).rejects.toMatchObject({ name: "ComisionInvalidaError" });
    await expect(registrar(1)).resolves.toMatchObject({ unidades: 1 });
  });

  it("solo cobra quien tiene la función, y la empresa del DO no se cobra a sí misma", async (ctx) => {
    const f = ensureDb(ctx);
    const tramite = await crearDo({ numContenedores: 2 });
    const registrar = (empresaId: string) =>
      registrarComisionTramite({ tramiteId: tramite.id, empresaId, unidades: 1, usuarioId: f.usuarioId });

    await expect(registrar(f.sinFuncionId)).rejects.toMatchObject({
      message: expect.stringContaining("no tiene activa la función «Comisión a cobrar por contenedor»"),
    });
    await expect(registrar(f.polyrecZfId)).rejects.toMatchObject({
      message: "La empresa del DO no puede pagarse comisión a sí misma.",
    });
  });
});
