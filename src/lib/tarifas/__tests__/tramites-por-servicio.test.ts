/**
 * Tarifas por servicio en la línea de trámites (DISENO-NUMERACION.md §2.2.3,
 * caso 24 del §8; decisión de Ernesto 30-sep-2026):
 *   - «Trámites»: servicio opcional — vacío = tarifa general de importación;
 *     TRASLADO_ZF, NACIONALIZACION_ZF o DUTA = la de ese servicio.
 *   - EXPORTACION no se puede declarar en «Trámites» (su tarifa es la general
 *     de la línea Exportación, sin servicio).
 *   - «Otros»: sigue obligatorio (B2) y sin los servicios de los trámites.
 *   - Publicar la de DUTA en «Trámites» no reemplaza la general ni la de traslado.
 *
 * Requiere PostgreSQL local con DATABASE_URL y las migraciones del 30-sep; si no, skip.
 */
import "dotenv/config";

import { Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { tarifaItemSchema, type TarifaItemPayload } from "@/lib/validations/tarifas";

import {
  TarifarioServicioNoAplicaError,
  TarifarioServicioRequeridoError,
  TarifarioServicioReservadoError,
  actualizarTarifario,
  cambiarEstadoTarifario,
  crearTarifario,
  duplicarTarifario,
  tarifarioVigenteDe,
} from "../service";

const TEST_PREFIX = "vitest-tarifa-servicio";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DIA = 86_400_000;

let listo = false;
let motivo: string | null = null;
let adminId = "";
let empresaId = "";

function ensureDb(ctx: { skip: (nota?: string) => void }) {
  if (!listo) ctx.skip(motivo ?? "BD local no disponible");
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const ids = clientes.map((c) => c.id);
  const tarifarios = await prisma.tarifario.findMany({ where: { empresaId: { in: ids } }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entidadId: { in: [...ids, ...tarifarios.map((t) => t.id)] } },
        { usuario: { email: { startsWith: TEST_PREFIX } } },
      ],
    },
  });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
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
  adminId = (
    await prisma.user.create({
      data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest tarifa servicio", rol: Rol.ADMIN },
    })
  ).id;
  empresaId = (
    await prisma.cliente.create({
      data: { nombre: "POLYREC ZF vitest", nit: `${TEST_PREFIX}-${RUN_ID}`, tipo: TipoCliente.PROPIO },
    })
  ).id;
  await setCapacidadesEmpresa({
    empresaId,
    cambios: [{ codigo: "tarifario_propio", habilitado: true }],
    usuarioId: adminId,
  });
  listo = true;
});

afterAll(async () => {
  if (listo) await limpiar();
});

function items(valor = 300_000): TarifaItemPayload[] {
  return [
    tarifaItemSchema.parse({
      concepto: "SERVICIO_DUTA",
      nombrePublico: "Servicio",
      tipoCalculo: "FIJO",
      disparador: "SIEMPRE",
      unidad: "TRAMITE",
      valor: BigInt(valor),
      aplicaIva: true,
      orden: 10,
    }),
  ];
}

function nueva(nombre: string, alcance: string, servicio: string | null, valor?: number) {
  return crearTarifario({
    empresaId,
    usuarioId: adminId,
    nombre,
    alcance: alcance as "TRAMITE",
    ciudades: [],
    conceptoServicioCodigo: servicio,
    vigenteDesde: new Date(Date.now() - 30 * DIA),
    vigenteHasta: new Date(Date.now() + 300 * DIA),
    items: items(valor),
  });
}

describe("caso 24 — qué servicio lleva una tarifa por línea", () => {
  it("«Trámites» con DUTA, NACIONALIZACION_ZF o TRASLADO_ZF → ok; vacío → tarifa general", async (ctx) => {
    ensureDb(ctx);
    const duta = await nueva("DUTA 2026", "TRAMITE", "DUTA");
    const nac = await nueva("Nacionalización ZF 2026", "TRAMITE", "NACIONALIZACION_ZF");
    const traslado = await nueva("Traslados zona franca 2026", "TRAMITE", "TRASLADO_ZF");
    const general = await nueva("Importación 2026", "TRAMITE", null);
    expect([duta, nac, traslado, general].map((t) => t.conceptoServicioCodigo)).toEqual([
      "DUTA",
      "NACIONALIZACION_ZF",
      "TRASLADO_ZF",
      null,
    ]);
  });

  it("«Trámites» con EXPORTACION o con un concepto que no es del catálogo → 422", async (ctx) => {
    ensureDb(ctx);
    await expect(nueva("Exportación en trámites", "TRAMITE", "EXPORTACION")).rejects.toBeInstanceOf(
      TarifarioServicioNoAplicaError,
    );
    await expect(nueva("Exportación en trámites", "TRAMITE", "EXPORTACION")).rejects.toThrow(
      /solo lleva uno de estos servicios: Traslado de zona franca, Nacionalización desde zona franca o DUTA/,
    );
    await expect(nueva("Plan Vallejo en trámites", "TRAMITE", "PLAN_VALLEJO")).rejects.toBeInstanceOf(
      TarifarioServicioNoAplicaError,
    );
  });

  it("Exportación y Clasificación no llevan servicio", async (ctx) => {
    ensureDb(ctx);
    await expect(nueva("Exportación con servicio", "EXPORTACION", "EXPORTACION")).rejects.toBeInstanceOf(
      TarifarioServicioNoAplicaError,
    );
    const exportacion = await nueva("Exportación 2026", "EXPORTACION", null);
    expect(exportacion.conceptoServicioCodigo).toBeNull();
    await expect(nueva("Clasificación con servicio", "CLASIFICACION", "DUTA")).rejects.toBeInstanceOf(
      TarifarioServicioNoAplicaError,
    );
  });

  it("«Otros» sin servicio → 422 (B2); con NACIONALIZACION_ZF o DUTA → 422 SERVICIO_RESERVADO", async (ctx) => {
    ensureDb(ctx);
    await expect(nueva("Otros sin servicio", "OTROS", null)).rejects.toBeInstanceOf(TarifarioServicioRequeridoError);
    await expect(nueva("Nacionalización como Otros", "OTROS", "NACIONALIZACION_ZF")).rejects.toBeInstanceOf(
      TarifarioServicioReservadoError,
    );
    await expect(nueva("DUTA como Otros", "OTROS", "DUTA")).rejects.toMatchObject({
      status: 422,
      codigo: "SERVICIO_RESERVADO",
    });
  });

  it("cambiar una tarifa de «Trámites» a DUTA y duplicarla conserva el servicio", async (ctx) => {
    ensureDb(ctx);
    const t = await nueva("General a DUTA", "TRAMITE", null);
    const cambiada = await actualizarTarifario(t.id, { conceptoServicioCodigo: "DUTA" }, adminId);
    expect(cambiada.conceptoServicioCodigo).toBe("DUTA");
    const copia = await duplicarTarifario(
      t.id,
      { vigenteDesde: new Date(Date.now() - DIA), vigenteHasta: new Date(Date.now() + 200 * DIA), redondeoA: 1_000 },
      adminId,
    );
    expect(copia.conceptoServicioCodigo).toBe("DUTA");
    await expect(actualizarTarifario(t.id, { conceptoServicioCodigo: "EXPORTACION" }, adminId)).rejects.toBeInstanceOf(
      TarifarioServicioNoAplicaError,
    );
  });

  it("publicar «Trámites» + DUTA no reemplaza la general ni la de traslado", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId } });
    const general = await cambiarEstadoTarifario((await nueva("Importación", "TRAMITE", null, 500_000)).id, "VIGENTE", adminId);
    const traslado = await cambiarEstadoTarifario(
      (await nueva("Traslados", "TRAMITE", "TRASLADO_ZF", 300_000)).id,
      "VIGENTE",
      adminId,
    );
    const duta = await cambiarEstadoTarifario((await nueva("DUTA", "TRAMITE", "DUTA", 240_000)).id, "VIGENTE", adminId);
    const duta2 = await cambiarEstadoTarifario((await nueva("DUTA v2", "TRAMITE", "DUTA", 250_000)).id, "VIGENTE", adminId);

    const estados = await prisma.tarifario.findMany({
      where: { id: { in: [general.id, traslado.id, duta.id, duta2.id] } },
      select: { id: true, estado: true },
    });
    const estadoDe = (id: string) => estados.find((e) => e.id === id)?.estado;
    expect(estadoDe(general.id)).toBe("VIGENTE");
    expect(estadoDe(traslado.id)).toBe("VIGENTE");
    expect(estadoDe(duta.id)).toBe("REEMPLAZADO");
    expect(estadoDe(duta2.id)).toBe("VIGENTE");

    // Cada servicio encuentra SU tarifa; la general no se entera.
    expect((await tarifarioVigenteDe(empresaId, "TRAMITE", undefined, null, null))?.id).toBe(general.id);
    expect((await tarifarioVigenteDe(empresaId, "TRAMITE", undefined, null, "TRASLADO_ZF"))?.id).toBe(traslado.id);
    expect((await tarifarioVigenteDe(empresaId, "TRAMITE", undefined, null, "DUTA"))?.id).toBe(duta2.id);
    expect(await tarifarioVigenteDe(empresaId, "TRAMITE", undefined, null, "NACIONALIZACION_ZF")).toBeNull();
  });
});
