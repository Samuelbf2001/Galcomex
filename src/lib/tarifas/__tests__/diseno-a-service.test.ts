/**
 * Diseño A (27-sep-2026) — tests de integración de servicio para B1 (restar
 * el agenciamiento) y B3 (tarifario por ciudad). Requiere PostgreSQL local en
 * :5433 con DATABASE_URL definida; si no está disponible, se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-diseno-a"
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTarifario, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { actualizarParametro, ParametroValorInvalidoError } from "@/lib/parametros/service";
import type { TarifaItemPayload } from "@/lib/validations/tarifas";

import {
  TarifaRestaDuplicadaError,
  TarifarioCiudadEnUsoError,
  agregarItemTarifario,
  actualizarItemTarifario,
  cambiarEstadoTarifario,
  contextoDeTramite,
  crearTarifario,
  duplicarTarifario,
  motivoSinTarifarioVigente,
  propuestaParaTramite,
  tarifarioVigenteDe,
} from "../service";

const TEST_PREFIX = "vitest-diseno-a";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const suf = Date.now().toString(36).toUpperCase();

type Fixture = { adminId: string; clienteId: string; conceptoActivoId: string };

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let contadorTramite = 0;

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupTestData() {
  const testUsers = await prisma.user.findMany({ where: { email: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const testClients = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const userIds = testUsers.map((u) => u.id);
  const clienteIds = testClients.map((c) => c.id);

  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: userIds } } });
  await prisma.tramiteDO.deleteMany({ where: { clienteId: { in: clienteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: { startsWith: `VITEST_DA_${suf}` } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const admin = await prisma.user.create({
    data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest Diseño A", rol: Rol.ADMIN },
  });
  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Diseño A", nit: `${TEST_PREFIX}-${runId}`, tipo: TipoCliente.PROPIO },
  });
  await setCapacidadesEmpresa({
    empresaId: cliente.id,
    cambios: [{ codigo: "tarifario_propio", habilitado: true }],
    usuarioId: admin.id,
  });
  const concepto = await prisma.conceptoVenta.create({
    data: { codigo: `VITEST_DA_${suf}_ACTIVO`, nombre: "Concepto activo vitest", activo: true },
  });
  return { adminId: admin.id, clienteId: cliente.id, conceptoActivoId: concepto.id };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no está definida; se omiten los tests de Diseño A";
    return;
  }
  try {
    await cleanupTestData();
    fixture = await createFixture();
  } catch (error) {
    dbUnavailableReason = `BD local Postgres no disponible: ${unavailableMessage(error)}`;
  }
});

afterAll(async () => {
  if (fixture) await cleanupTestData();
});

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de Diseño A");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

function itemAsesoria(overrides: Partial<TarifaItemPayload> = {}): TarifaItemPayload {
  return {
    concepto: "ASESORIA",
    nombrePublico: "Asesoría",
    siigoCodigo: null,
    tipoCalculo: "PORCENTAJE_MIN",
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: 20,
    minimos: { SUELTA: "305000" },
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    notas: null,
    orden: 1,
    restaAgenciamiento: true,
    minimoEsDelTotal: false,
    ...overrides,
  };
}

async function crearTramiteDeCliente(
  clienteId: string,
  adminId: string,
  opciones: { ciudad?: Ciudad; agenciaAduanas?: AgenciaAduanas | null; valorCif?: bigint; tipoCarga?: "SUELTA" } = {},
) {
  contadorTramite += 1;
  return prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.${opciones.ciudad ?? Ciudad.CTG}26-VDA${suf}${contadorTramite}`,
      tipoTramiteCodigo: "IMPORTACION",
      ciudad: opciones.ciudad ?? Ciudad.CTG,
      anio: 2026,
      numero: 900_000 + contadorTramite,
      clienteId,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      // `?? ` trataría un `null` explícito igual que "no vino": aquí sí hay
      // que distinguirlos (un test pide un DO SIN agencia a propósito).
      agenciaAduanas: opciones.agenciaAduanas === undefined ? AgenciaAduanas.COLDEX : opciones.agenciaAduanas,
      valorCif: opciones.valorCif ?? 220_664_129n,
      tipoCarga: opciones.tipoCarga ?? "SUELTA",
    },
  });
}

describe("Diseño A — B1 (restar agenciamiento): servicio", () => {
  it("crear conserva restaAgenciamiento / minimoEsDelTotal en el ítem", async (ctx) => {
    const db = ensureDb(ctx);
    const t = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Tarifario B1 ${runId}`,
      alcance: "TRAMITE",
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria()],
    });
    expect(t.items).toHaveLength(1);
    expect(t.items[0]!.restaAgenciamiento).toBe(true);
    expect(t.items[0]!.minimoEsDelTotal).toBe(false);
  });

  it("duplicar conserva restaAgenciamiento / minimoEsDelTotal", async (ctx) => {
    const db = ensureDb(ctx);
    const origen = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Tarifario B1 origen ${runId}`,
      alcance: "CLASIFICACION",
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria({ minimoEsDelTotal: true, minimos: { SUELTA: "450000" } })],
    });
    const copia = await duplicarTarifario(
      origen.id,
      { vigenteDesde: new Date("2027-01-01"), vigenteHasta: new Date("2027-12-31"), redondeoA: 1000 },
      db.adminId,
    );
    expect(copia.items[0]!.restaAgenciamiento).toBe(true);
    expect(copia.items[0]!.minimoEsDelTotal).toBe(true);
  });

  it("agregarItemTarifario: un segundo ítem con resta → TarifaRestaDuplicadaError", async (ctx) => {
    const db = ensureDb(ctx);
    const t = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Tarifario B1 duplicada ${runId}`,
      alcance: "PLAN_VALLEJO",
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria({ concepto: "ASESORIA" })],
    });
    // El chequeo de resta duplicada corre ANTES de exigir el catálogo activo,
    // así que ni siquiera necesita un concepto real para fallar por esta causa.
    await expect(
      agregarItemTarifario(t.id, itemAsesoria({ concepto: "NACIONALIZACION" }), db.adminId),
    ).rejects.toBeInstanceOf(TarifaRestaDuplicadaError);
  });

  it("actualizarItemTarifario: marcar resta cuando otro ítem ya resta → TarifaRestaDuplicadaError", async (ctx) => {
    const db = ensureDb(ctx);
    const t = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Tarifario B1 editar ${runId}`,
      alcance: "EXPORTACION",
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [
        itemAsesoria({ concepto: "ASESORIA" }),
        itemAsesoria({ concepto: "OTRO_ITEM", restaAgenciamiento: false }),
      ],
    });
    const otroItem = t.items.find((i) => i.concepto === "OTRO_ITEM")!;
    await expect(
      actualizarItemTarifario(t.id, otroItem.id, { restaAgenciamiento: true }, db.adminId),
    ).rejects.toBeInstanceOf(TarifaRestaDuplicadaError);
  });

  it("contextoDeTramite: con agencia trae el agenciamiento estándar; sin agencia, agencia null", async (ctx) => {
    const db = ensureDb(ctx);
    await actualizarParametro("AGENCIAMIENTO_COLDEX", "145000", db.adminId);

    const conAgencia = await crearTramiteDeCliente(db.clienteId, db.adminId, { agenciaAduanas: AgenciaAduanas.COLDEX });
    const ctxConAgencia = await contextoDeTramite(conAgencia.id);
    expect(ctxConAgencia.agenciamiento).toEqual({ agencia: "COLDEX", valor: 145_000n });

    const sinAgencia = await crearTramiteDeCliente(db.clienteId, db.adminId, { agenciaAduanas: null });
    const ctxSinAgencia = await contextoDeTramite(sinAgencia.id);
    expect(ctxSinAgencia.agenciamiento).toEqual({ agencia: null, valor: null });
  });

  it("propuestaParaTramite: con el ítem de resta y agencia sin valor, queda pendiente (no cobra de más)", async (ctx) => {
    const db = ensureDb(ctx);
    await actualizarParametro("AGENCIAMIENTO_AR_LOGISTY", "", db.adminId).catch(() => {
      // El PATCH exige min 1 char; si falla, no importa: el parámetro nace vacío del seed.
    });
    const t = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Tarifario B1 propuesta ${runId}`,
      alcance: "TRAMITE",
      vigenteDesde: new Date("2020-01-01"),
      vigenteHasta: new Date("2030-12-31"),
      notas: null,
      items: [itemAsesoria()],
    });
    await cambiarEstadoTarifario(t.id, "VIGENTE", db.adminId);

    const tramite = await crearTramiteDeCliente(db.clienteId, db.adminId, { agenciaAduanas: AgenciaAduanas.AR_LOGISTY });
    const propuesta = await propuestaParaTramite(tramite.id);
    expect(propuesta.resultado?.lineas).toEqual([]);
    expect(propuesta.resultado?.pendientes).toHaveLength(1);
    expect(propuesta.resultado?.pendientes[0]!.causa).toBe("TARIFARIO");
  });

  it("parametros/service — AGENCIAMIENTO_COLDEX con puntos → 422", async (ctx) => {
    const db = ensureDb(ctx);
    await expect(actualizarParametro("AGENCIAMIENTO_COLDEX", "145.000", db.adminId)).rejects.toBeInstanceOf(
      ParametroValorInvalidoError,
    );
    // Deja el parámetro en un valor conocido para el resto de la suite.
    await actualizarParametro("AGENCIAMIENTO_COLDEX", "145000", db.adminId);
  });
});

describe("Diseño A — B3 (tarifario por ciudad): servicio", () => {
  it("R1 — ciudad especializada VIGENTE en fecha manda sobre el general", async (ctx) => {
    const db = ensureDb(ctx);
    const general = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `General ${runId}`,
      alcance: "EXPORTACION",
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false })],
    });
    await cambiarEstadoTarifario(general.id, "VIGENTE", db.adminId);

    const bogota = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Bogotá ${runId}`,
      alcance: "EXPORTACION",
      ciudades: [Ciudad.BGT],
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false, porcentajeBps: 30 })],
    });
    await cambiarEstadoTarifario(bogota.id, "VIGENTE", db.adminId);

    const paraBgt = await tarifarioVigenteDe(db.clienteId, "EXPORTACION", new Date("2026-06-01"), Ciudad.BGT);
    expect(paraBgt?.id).toBe(bogota.id);

    const paraOtra = await tarifarioVigenteDe(db.clienteId, "EXPORTACION", new Date("2026-06-01"), Ciudad.CTG);
    expect(paraOtra?.id).toBe(general.id);

    const sinCiudad = await tarifarioVigenteDe(db.clienteId, "EXPORTACION", new Date("2026-06-01"));
    // Comportamiento de hoy: cualquier VIGENTE en fecha (mayor versión primero).
    expect([general.id, bogota.id]).toContain(sinCiudad?.id);
  });

  it("R1 — ciudad especializada fuera de fecha NUNCA cae al general en silencio", async (ctx) => {
    const db = ensureDb(ctx);
    const general = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `General2 ${runId}`,
      alcance: "PLAN_VALLEJO",
      vigenteDesde: new Date("2020-01-01"),
      vigenteHasta: new Date("2030-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false })],
    });
    await cambiarEstadoTarifario(general.id, "VIGENTE", db.adminId);

    const bogotaVencida = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `BogotáVencida ${runId}`,
      alcance: "PLAN_VALLEJO",
      ciudades: [Ciudad.BGT],
      vigenteDesde: new Date("2020-01-01"),
      vigenteHasta: new Date("2020-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false })],
    });
    await cambiarEstadoTarifario(bogotaVencida.id, "VIGENTE", db.adminId);

    const resultado = await tarifarioVigenteDe(db.clienteId, "PLAN_VALLEJO", new Date("2026-06-01"), Ciudad.BGT);
    expect(resultado).toBeNull();

    const { ciudadFueraDeFecha } = await motivoSinTarifarioVigente(db.clienteId, "PLAN_VALLEJO", Ciudad.BGT);
    expect(ciudadFueraDeFecha).toBe(true);
  });

  it("M2 (revisión de código, 28-sep-2026) — publicar por adelantado un tarifario de ciudad NO deja esa ciudad sin tarifa hoy", async (ctx) => {
    const db = ensureDb(ctx);
    const general = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `GeneralM2 ${runId}`,
      alcance: "CLASIFICACION",
      vigenteDesde: new Date("2020-01-01"),
      vigenteHasta: new Date("2030-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false, concepto: "ASESORIA_M2" })],
    });
    await cambiarEstadoTarifario(general.id, "VIGENTE", db.adminId);

    // Camila publica hoy "Bogotá 2027" con vigencia desde el próximo año.
    const bogota2027 = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Bogotá2027M2 ${runId}`,
      alcance: "CLASIFICACION",
      ciudades: [Ciudad.BGT],
      vigenteDesde: new Date("2027-01-01"),
      vigenteHasta: new Date("2027-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false, concepto: "ASESORIA_M2" })],
    });
    await cambiarEstadoTarifario(bogota2027.id, "VIGENTE", db.adminId);

    // Hoy (antes de que empiece el de Bogotá 2027): Bogotá sigue usando el general.
    const hoy = await tarifarioVigenteDe(db.clienteId, "CLASIFICACION", new Date("2026-06-01"), Ciudad.BGT);
    expect(hoy?.id).toBe(general.id);
    const { ciudadFueraDeFecha: fueraDeFechaHoy } = await motivoSinTarifarioVigente(
      db.clienteId,
      "CLASIFICACION",
      Ciudad.BGT,
      new Date("2026-06-01"),
    );
    expect(fueraDeFechaHoy).toBe(false);

    // El 1-ene-2027 (cuando `vigenteDesde` ya llegó): Bogotá pasa a especializarse.
    const enero2027 = await tarifarioVigenteDe(db.clienteId, "CLASIFICACION", new Date("2027-01-01"), Ciudad.BGT);
    expect(enero2027?.id).toBe(bogota2027.id);

    // Otra ciudad sin tarifario propio sigue con el general, hoy y después.
    const otraCiudad = await tarifarioVigenteDe(db.clienteId, "CLASIFICACION", new Date("2026-06-01"), Ciudad.CTG);
    expect(otraCiudad?.id).toBe(general.id);
  });

  it("R2 — publicar con una ciudad ya usada por otro VIGENTE de conjunto distinto → 422", async (ctx) => {
    const db = ensureDb(ctx);
    const bogota1 = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `BogotáR2-1 ${runId}`,
      alcance: "CLASIFICACION",
      ciudades: [Ciudad.BGT],
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false })],
    });
    await cambiarEstadoTarifario(bogota1.id, "VIGENTE", db.adminId);

    const bogotaYCtg = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `Bogotá+CTG ${runId}`,
      alcance: "CLASIFICACION",
      ciudades: [Ciudad.BGT, Ciudad.CTG],
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false })],
    });

    await expect(cambiarEstadoTarifario(bogotaYCtg.id, "VIGENTE", db.adminId)).rejects.toBeInstanceOf(
      TarifarioCiudadEnUsoError,
    );
  });

  it("R2 — publicar con EXACTAMENTE el mismo conjunto de ciudades reemplaza al anterior", async (ctx) => {
    const db = ensureDb(ctx);
    const v1 = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `SantaMartaV1 ${runId}`,
      alcance: "TRAMITE",
      ciudades: [Ciudad.SMR],
      vigenteDesde: new Date("2026-01-01"),
      vigenteHasta: new Date("2026-06-30"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false })],
    });
    await cambiarEstadoTarifario(v1.id, "VIGENTE", db.adminId);

    const v2 = await duplicarTarifario(
      v1.id,
      { vigenteDesde: new Date("2026-07-01"), vigenteHasta: new Date("2026-12-31"), redondeoA: 1000 },
      db.adminId,
    );
    expect(v2.ciudades).toEqual([Ciudad.SMR]);

    const publicado = await cambiarEstadoTarifario(v2.id, "VIGENTE", db.adminId);
    expect(publicado.estado).toBe(EstadoTarifario.VIGENTE);

    const v1Refrescado = await prisma.tarifario.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1Refrescado.estado).toBe(EstadoTarifario.REEMPLAZADO);
  });

  it("R3 — vencer el tarifario de una ciudad la devuelve al general", async (ctx) => {
    const db = ensureDb(ctx);
    const general = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `GeneralR3 ${runId}`,
      alcance: "TRAMITE",
      vigenteDesde: new Date("2020-01-01"),
      vigenteHasta: new Date("2030-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false, concepto: "ASESORIA_R3" })],
    });
    await cambiarEstadoTarifario(general.id, "VIGENTE", db.adminId);

    const bun = await crearTarifario({
      empresaId: db.clienteId,
      usuarioId: db.adminId,
      nombre: `BuenaventuraR3 ${runId}`,
      alcance: "TRAMITE",
      ciudades: [Ciudad.BUN],
      vigenteDesde: new Date("2020-01-01"),
      vigenteHasta: new Date("2030-12-31"),
      notas: null,
      items: [itemAsesoria({ restaAgenciamiento: false, concepto: "ASESORIA_R3" })],
    });
    await cambiarEstadoTarifario(bun.id, "VIGENTE", db.adminId);

    expect((await tarifarioVigenteDe(db.clienteId, "TRAMITE", new Date("2026-06-01"), Ciudad.BUN))?.id).toBe(bun.id);

    await cambiarEstadoTarifario(bun.id, "VENCIDO", db.adminId);

    expect((await tarifarioVigenteDe(db.clienteId, "TRAMITE", new Date("2026-06-01"), Ciudad.BUN))?.id).toBe(
      general.id,
    );
  });
});
