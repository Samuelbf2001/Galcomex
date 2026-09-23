/**
 * Tests de integración — Tarifario: catálogo de conceptos (B1) y "Arrancar
 * desde" con la tarifa de otra empresa (B2), 22-sep-2026.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida. Si la BD no
 * está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-tarifas-service"
 */
import "dotenv/config";

import {
  DisparadorTarifa,
  EstadoTarifario,
  Rol,
  TipoCalculoTarifa,
  TipoCliente,
  UnidadTarifa,
} from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { ALCANCES_TARIFARIO, type TarifaItemPayload } from "@/lib/validations/tarifas";

import {
  ConceptoNoEnCatalogoError,
  TarifarioNoHabilitadoError,
  agregarItemTarifario,
  actualizarItemTarifario,
  crearTarifario,
  crearTarifarioDesde,
  listarTarifariosLigero,
  tarifarioVigenteDe,
} from "../service";

const TEST_PREFIX = "vitest-tarifas-service";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const suf = Date.now().toString(36).toUpperCase();

const CODIGO_ACTIVO_1 = `VITEST_TAR_${suf}_A`;
const CODIGO_ACTIVO_2 = `VITEST_TAR_${suf}_B`;
const CODIGO_INACTIVO = `VITEST_TAR_${suf}_INAC`;
const CODIGO_INEXISTENTE = `VITEST_TAR_${suf}_NOPE`;
const CODIGOS_CONCEPTO = [CODIGO_ACTIVO_1, CODIGO_ACTIVO_2, CODIGO_INACTIVO];
const CODIGOS_SIIGO = [`SIIGO-${suf}-1`, `SIIGO-${suf}-2`];

type Fixture = {
  adminId: string;
  clienteOrigenId: string;
  clienteDestinoId: string;
  clienteSinCapacidadId: string;
  conceptoActivo1Id: string;
  conceptoActivo2Id: string;
  siigoCodigo1: string;
  siigoCodigo2: string;
};

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupTestData() {
  const testUsers = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const testClients = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const userIds = testUsers.map((u) => u.id);
  const clienteIds = testClients.map((c) => c.id);

  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: userIds } } });
  // Tarifario → TarifaItem en cascada (onDelete: Cascade).
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: { in: CODIGOS_CONCEPTO } } });
  await prisma.siigoProducto.deleteMany({ where: { codigo: { in: CODIGOS_SIIGO } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const admin = await prisma.user.create({
    data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest Tarifas Service", rol: Rol.ADMIN },
  });

  const clienteOrigen = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Tarifas Origen", nit: `${TEST_PREFIX}-origen-${runId}`, tipo: TipoCliente.PROPIO },
  });
  const clienteDestino = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Tarifas Destino", nit: `${TEST_PREFIX}-destino-${runId}`, tipo: TipoCliente.PROPIO },
  });
  const clienteSinCapacidad = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Tarifas Sin Capacidad", nit: `${TEST_PREFIX}-sincap-${runId}`, tipo: TipoCliente.PROPIO },
  });

  await setCapacidadesEmpresa({
    empresaId: clienteOrigen.id,
    cambios: [{ codigo: "tarifario_propio", habilitado: true }],
    usuarioId: admin.id,
  });
  await setCapacidadesEmpresa({
    empresaId: clienteDestino.id,
    cambios: [{ codigo: "tarifario_propio", habilitado: true }],
    usuarioId: admin.id,
  });

  const siigo1 = await prisma.siigoProducto.create({
    data: {
      id: `${runId}-siigo-1`,
      codigo: CODIGOS_SIIGO[0]!,
      nombre: "PRODUCTO VITEST TARIFAS 1",
      tipo: "Servicios",
      grupoContableId: 1,
      grupoContableNombre: "Servicios",
      clasificacionIva: "Gravado - IVA 19%",
    },
  });
  const siigo2 = await prisma.siigoProducto.create({
    data: {
      id: `${runId}-siigo-2`,
      codigo: CODIGOS_SIIGO[1]!,
      nombre: "PRODUCTO VITEST TARIFAS 2",
      tipo: "Servicios",
      grupoContableId: 1,
      grupoContableNombre: "Servicios",
      clasificacionIva: "Gravado - IVA 19%",
    },
  });

  const conceptoActivo1 = await prisma.conceptoVenta.create({
    data: {
      codigo: CODIGO_ACTIVO_1,
      nombre: "Concepto Vitest Activo 1",
      siigoProductoId: siigo1.id,
      aplicaIva: true,
      activo: true,
      tipoCalculoSugerido: TipoCalculoTarifa.POR_UNIDAD,
      unidadSugerida: UnidadTarifa.DOCUMENTO,
    },
  });
  const conceptoActivo2 = await prisma.conceptoVenta.create({
    data: {
      codigo: CODIGO_ACTIVO_2,
      nombre: "Concepto Vitest Activo 2",
      siigoProductoId: siigo2.id,
      aplicaIva: false,
      activo: true,
    },
  });
  await prisma.conceptoVenta.create({
    data: { codigo: CODIGO_INACTIVO, nombre: "Concepto Vitest Inactivo", activo: false },
  });

  return {
    adminId: admin.id,
    clienteOrigenId: clienteOrigen.id,
    clienteDestinoId: clienteDestino.id,
    clienteSinCapacidadId: clienteSinCapacidad.id,
    conceptoActivo1Id: conceptoActivo1.id,
    conceptoActivo2Id: conceptoActivo2.id,
    siigoCodigo1: siigo1.codigo,
    siigoCodigo2: siigo2.codigo,
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de tarifas");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function itemPayload(
  overrides: Partial<TarifaItemPayload> & Pick<TarifaItemPayload, "concepto">,
): TarifaItemPayload {
  return {
    nombrePublico: "Ítem vitest",
    siigoCodigo: null,
    tipoCalculo: TipoCalculoTarifa.FIJO,
    disparador: DisparadorTarifa.SIEMPRE,
    eventoCodigo: null,
    unidad: UnidadTarifa.TRAMITE,
    valor: 100_000n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    notas: null,
    orden: 10,
    ...overrides,
  };
}

async function crearTarifarioBorradorTest(
  empresaId: string,
  adminId: string,
  alcance: (typeof ALCANCES_TARIFARIO)[number] = "TRAMITE",
) {
  return crearTarifario({
    empresaId,
    nombre: `Tarifario vitest ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    alcance,
    vigenteDesde: new Date("2026-01-01T00:00:00.000Z"),
    vigenteHasta: new Date("2026-12-31T00:00:00.000Z"),
    notas: null,
    items: [],
    usuarioId: adminId,
  });
}

/** Tarifario ya VIGENTE, sin pasar por el ciclo BORRADOR → publicar (F5). */
async function crearTarifarioVigenteDirecto(
  empresaId: string,
  adminId: string,
  opciones: { desde: Date; hasta: Date; alcance?: (typeof ALCANCES_TARIFARIO)[number] },
) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: `Tarifario vitest vigente ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      alcance: opciones.alcance ?? "TRAMITE",
      estado: EstadoTarifario.VIGENTE,
      vigenteDesde: opciones.desde,
      vigenteHasta: opciones.hasta,
      creadoPorId: adminId,
    },
  });
}

describe("tarifas service — catálogo de conceptos y copiar de otra empresa, con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida; se omiten tests de integración con Postgres";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      fixture = await createFixture();
    } catch (error) {
      dbUnavailableReason = `BD local Postgres no disponible: ${unavailableMessage(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) await cleanupTestData();
    await prisma.$disconnect();
  });

  // ─── B1: alta/edición MANUAL exige un concepto ACTIVO del catálogo ──────────

  describe("agregarItemTarifario — catálogo de conceptos (B1)", () => {
    it("concepto activo: crea el ítem y fuerza el siigoCodigo del catálogo (ignora el que mande el cliente)", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);

      const actualizado = await agregarItemTarifario(
        tarifario.id,
        itemPayload({ concepto: CODIGO_ACTIVO_1, siigoCodigo: "000-NO-DEBERIA-QUEDAR" }),
        db.adminId,
      );

      const item = actualizado.items.find((i) => i.concepto === CODIGO_ACTIVO_1);
      expect(item).toBeDefined();
      expect(item?.siigoCodigo).toBe(db.siigoCodigo1);
      expect(item?.conceptoId).toBe(db.conceptoActivo1Id);
    });

    it("concepto que no existe en el catálogo: ConceptoNoEnCatalogoError (422, español)", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);

      const promesa = agregarItemTarifario(tarifario.id, itemPayload({ concepto: CODIGO_INEXISTENTE }), db.adminId);
      await expect(promesa).rejects.toBeInstanceOf(ConceptoNoEnCatalogoError);
      await expect(promesa.catch((e: Error) => ({ status: (e as Error & { status: number }).status, message: e.message }))).resolves.toMatchObject({
        status: 422,
      });
      await expect(
        agregarItemTarifario(tarifario.id, itemPayload({ concepto: CODIGO_INEXISTENTE }), db.adminId),
      ).rejects.toThrow(/no existe en el catálogo/);
    });

    it("concepto inactivo: también se rechaza", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);

      await expect(
        agregarItemTarifario(tarifario.id, itemPayload({ concepto: CODIGO_INACTIVO }), db.adminId),
      ).rejects.toBeInstanceOf(ConceptoNoEnCatalogoError);
    });
  });

  describe("actualizarItemTarifario — catálogo de conceptos (B1)", () => {
    it("cambiar a un concepto activo distinto recalcula el siigoCodigo (ignora el enviado)", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);
      const conItem = await agregarItemTarifario(tarifario.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);
      const item = conItem.items[0]!;

      const actualizado = await actualizarItemTarifario(
        tarifario.id,
        item.id,
        { concepto: CODIGO_ACTIVO_2, siigoCodigo: "000-IGNORAR" },
        db.adminId,
      );

      const itemActualizado = actualizado.items.find((i) => i.id === item.id);
      expect(itemActualizado?.concepto).toBe(CODIGO_ACTIVO_2);
      expect(itemActualizado?.siigoCodigo).toBe(db.siigoCodigo2);
      expect(itemActualizado?.conceptoId).toBe(db.conceptoActivo2Id);
    });

    it("cambiar a un concepto que no existe: rechaza", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);
      const conItem = await agregarItemTarifario(tarifario.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);
      const item = conItem.items[0]!;

      await expect(
        actualizarItemTarifario(tarifario.id, item.id, { concepto: CODIGO_INEXISTENTE }, db.adminId),
      ).rejects.toBeInstanceOf(ConceptoNoEnCatalogoError);
    });

    it("un ítem LEGACY (concepto fuera del catálogo) se puede seguir editando en otros campos sin tocar `concepto`", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);
      // Simula un ítem de antes del maestro de conceptos: inserción directa,
      // sin pasar por `agregarItemTarifario`.
      const legacy = await prisma.tarifaItem.create({
        data: {
          tarifarioId: tarifario.id,
          orden: 1,
          concepto: CODIGO_INEXISTENTE,
          nombrePublico: "Ítem legacy",
          tipoCalculo: TipoCalculoTarifa.FIJO,
          disparador: DisparadorTarifa.SIEMPRE,
          unidad: UnidadTarifa.TRAMITE,
          valor: 50_000n,
          aplicaIva: true,
        },
      });

      const actualizado = await actualizarItemTarifario(tarifario.id, legacy.id, { orden: 99 }, db.adminId);
      const itemActualizado = actualizado.items.find((i) => i.id === legacy.id);
      expect(itemActualizado?.orden).toBe(99);
      expect(itemActualizado?.concepto).toBe(CODIGO_INEXISTENTE);
    });
  });

  // ─── B2: crearTarifarioDesde ─────────────────────────────────────────────────

  describe("crearTarifarioDesde — copiar la tarifa de otra empresa (B2)", () => {
    it("crea un BORRADOR v1, copia los ítems y pone la nota por defecto", async (ctx) => {
      const db = ensureDb(ctx);
      const origen = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId, "EXPORTACION");
      await agregarItemTarifario(
        origen.id,
        itemPayload({ concepto: CODIGO_ACTIVO_1, nombrePublico: "Ítem A", valor: 111_000n, orden: 10 }),
        db.adminId,
      );
      const origenConItems = await agregarItemTarifario(
        origen.id,
        itemPayload({
          concepto: CODIGO_ACTIVO_2,
          nombrePublico: "Ítem B",
          tipoCalculo: TipoCalculoTarifa.POR_UNIDAD,
          unidad: UnidadTarifa.DOCUMENTO,
          valor: 22_000n,
          orden: 20,
        }),
        db.adminId,
      );

      const nuevo = await crearTarifarioDesde(
        {
          origenTarifarioId: origen.id,
          empresaId: db.clienteDestinoId,
          alcance: "EXPORTACION",
          vigenteDesde: new Date("2027-01-01T00:00:00.000Z"),
          vigenteHasta: new Date("2027-12-31T00:00:00.000Z"),
        },
        db.adminId,
      );

      expect(nuevo.empresaId).toBe(db.clienteDestinoId);
      expect(nuevo.estado).toBe("BORRADOR");
      expect(nuevo.version).toBe(1);
      expect(nuevo.nombre).toBe(origenConItems.nombre);
      expect(nuevo.notas).toBe(
        `Copiado de ${origenConItems.empresa.nombre} · ${origenConItems.nombre} v${origenConItems.version}`,
      );
      expect(nuevo.items).toHaveLength(2);

      const a = nuevo.items.find((i) => i.concepto === CODIGO_ACTIVO_1);
      const b = nuevo.items.find((i) => i.concepto === CODIGO_ACTIVO_2);
      expect(a?.valor).toBe(111_000n);
      expect(a?.nombrePublico).toBe("Ítem A");
      expect(b?.valor).toBe(22_000n);
      expect(b?.unidad).toBe("DOCUMENTO");
      // Todos los campos se copian salvo los ids.
      expect(nuevo.items.every((i) => !origenConItems.items.some((oi) => oi.id === i.id))).toBe(true);

      const auditLog = await prisma.auditLog.findFirst({
        where: { entidad: "Tarifario", entidadId: nuevo.id, accion: "CREAR_TARIFARIO_DESDE" },
      });
      expect(auditLog).not.toBeNull();
    });

    it("nombre y notas explícitos ganan sobre los valores por defecto", async (ctx) => {
      const db = ensureDb(ctx);
      const origen = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId, "PLAN_VALLEJO");
      await agregarItemTarifario(origen.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);

      const nuevo = await crearTarifarioDesde(
        {
          origenTarifarioId: origen.id,
          empresaId: db.clienteDestinoId,
          nombre: "Nombre a mano",
          alcance: "PLAN_VALLEJO",
          vigenteDesde: new Date("2027-01-01T00:00:00.000Z"),
          vigenteHasta: new Date("2027-12-31T00:00:00.000Z"),
          notas: "Nota a mano",
        },
        db.adminId,
      );

      expect(nuevo.nombre).toBe("Nombre a mano");
      expect(nuevo.notas).toBe("Nota a mano");
    });

    it("segunda copia al mismo (empresa, alcance): la siguiente versión", async (ctx) => {
      const db = ensureDb(ctx);
      const origen = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId, "OTROS");
      await agregarItemTarifario(origen.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);

      const primera = await crearTarifarioDesde(
        {
          origenTarifarioId: origen.id,
          empresaId: db.clienteDestinoId,
          alcance: "OTROS",
          vigenteDesde: new Date("2027-01-01T00:00:00.000Z"),
          vigenteHasta: new Date("2027-12-31T00:00:00.000Z"),
        },
        db.adminId,
      );
      const segunda = await crearTarifarioDesde(
        {
          origenTarifarioId: origen.id,
          empresaId: db.clienteDestinoId,
          alcance: "OTROS",
          vigenteDesde: new Date("2028-01-01T00:00:00.000Z"),
          vigenteHasta: new Date("2028-12-31T00:00:00.000Z"),
        },
        db.adminId,
      );

      expect(segunda.version).toBe(primera.version + 1);
    });

    it("empresa destino sin la función tarifario_propio: TarifarioNoHabilitadoError", async (ctx) => {
      const db = ensureDb(ctx);
      const origen = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId);
      await agregarItemTarifario(origen.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);

      await expect(
        crearTarifarioDesde(
          {
            origenTarifarioId: origen.id,
            empresaId: db.clienteSinCapacidadId,
            alcance: "TRAMITE",
            vigenteDesde: new Date("2027-01-01T00:00:00.000Z"),
            vigenteHasta: new Date("2027-12-31T00:00:00.000Z"),
          },
          db.adminId,
        ),
      ).rejects.toBeInstanceOf(TarifarioNoHabilitadoError);
    });

    it("F7 — sin `alcance` en el payload, hereda el del tarifario de ORIGEN (no 'TRAMITE' a ciegas)", async (ctx) => {
      const db = ensureDb(ctx);
      // PLAN_VALLEJO (no TRAMITE) para probar que de verdad no cae al default
      // viejo; alcance que ningún otro test de este archivo reutiliza para
      // no interferir con los conteos de versión de otros `it`.
      const origen = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId, "PLAN_VALLEJO");
      await agregarItemTarifario(origen.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);

      const nuevo = await crearTarifarioDesde(
        {
          origenTarifarioId: origen.id,
          empresaId: db.clienteDestinoId,
          // Sin `alcance`: antes del fix quedaba "TRAMITE" a ciegas.
          vigenteDesde: new Date("2027-01-01T00:00:00.000Z"),
          vigenteHasta: new Date("2027-12-31T00:00:00.000Z"),
        },
        db.adminId,
      );

      expect(nuevo.alcance).toBe("PLAN_VALLEJO");
    });
  });

  // ─── B2: catálogo ligero para "Copiar la tarifa de otra empresa" ────────────

  describe("listarTarifariosLigero — catálogo de todas las empresas (B2)", () => {
    it("incluye empresa, alcance, versión, estado y cantidad de ítems", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId, "CLASIFICACION");
      await agregarItemTarifario(tarifario.id, itemPayload({ concepto: CODIGO_ACTIVO_1 }), db.adminId);

      const lista = await listarTarifariosLigero();
      const fila = lista.find((t) => t.id === tarifario.id);
      expect(fila).toMatchObject({
        empresaId: db.clienteOrigenId,
        alcance: "CLASIFICACION",
        version: 1,
        estado: "BORRADOR",
        items: 1,
      });
      expect(fila?.empresaNombre.length).toBeGreaterThan(0);
    });

    it("excluirEmpresaId quita los tarifarios de esa empresa", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioBorradorTest(db.clienteOrigenId, db.adminId, "OTROS");

      const conTodos = await listarTarifariosLigero();
      expect(conTodos.some((t) => t.id === tarifario.id)).toBe(true);

      const sinOrigen = await listarTarifariosLigero({ excluirEmpresaId: db.clienteOrigenId });
      expect(sinOrigen.some((t) => t.id === tarifario.id)).toBe(false);
    });
  });

  // ─── F5: tarifarioVigenteDe usa el día calendario en Bogotá por defecto ─────

  describe("tarifarioVigenteDe — sin `fecha`, usa 'hoy' en Bogotá, no el instante UTC (F5)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("vigenteHasta 2027-01-31: sigue vigente a las 23:30 Bogotá y ya no a las 00:30 Bogotá del día siguiente", async (ctx) => {
      const db = ensureDb(ctx);
      const tarifario = await crearTarifarioVigenteDirecto(db.clienteSinCapacidadId, db.adminId, {
        desde: new Date("2026-01-01T00:00:00.000Z"),
        hasta: new Date("2027-01-31T00:00:00.000Z"),
        alcance: "OTROS",
      });

      vi.useFakeTimers({ toFake: ["Date"] });

      // 2027-01-31 23:30 Bogotá = 2027-02-01 04:30Z
      vi.setSystemTime(new Date("2027-02-01T04:30:00.000Z"));
      expect((await tarifarioVigenteDe(db.clienteSinCapacidadId, "OTROS"))?.id).toBe(tarifario.id);

      // 2027-02-01 00:30 Bogotá = 2027-02-01 05:30Z
      vi.setSystemTime(new Date("2027-02-01T05:30:00.000Z"));
      expect(await tarifarioVigenteDe(db.clienteSinCapacidadId, "OTROS")).toBeNull();
    });
  });
});
