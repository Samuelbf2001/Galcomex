import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Rol,
  TipoCliente,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  formatConsecutivo,
  type ConfigConsecutivo,
} from "@/lib/tramites/consecutivo";
import { createTramite, listTramites, transitionTramite } from "../service";

/**
 * Config del tipo IMPORTACION (M4). El formato del consecutivo ya no está
 * quemado en el servicio: sale de `TipoTramite`. Estos son los valores que la
 * migración siembra para el trámite de siempre.
 */
const IMPORTACION: ConfigConsecutivo = {
  prefijoConsecutivo: "DO",
  secuenciaPor: "CIUDAD_ANIO",
  incluyeCiudadEnConsecutivo: true,
};

/**
 * Estos tests no son sobre los requisitos D1/D2 (tarifa vigente, BL + factura
 * comercial), que vienen encendidos por defecto: las empresas de prueba los
 * tienen apagados. Esas reglas se prueban en `requisitos.integration.test.ts`.
 */
const SIN_REQUISITOS_DO = [
  { codigo: "do_exige_tarifa_vigente", habilitado: false },
  { codigo: "docs_bl_factura_obligatorios", habilitado: false },
];

const TEST_PREFIX = "vitest-tramites";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const templatePrefix = "000 Vitest Tramites";
const stateYear = 2098;
const concurrencyYear = 2099;

type Fixture = {
  clienteId: string;
  userId: string;
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

  const userIds = testUsers.map((user) => user.id);
  const clienteIds = testClients.map((cliente) => cliente.id);

  const testTramites = await prisma.tramiteDO.findMany({
    where: {
      OR: [
        { creadoPorId: { in: userIds } },
        { clienteId: { in: clienteIds } },
        { comentarios: { startsWith: TEST_PREFIX } },
      ],
    },
    select: { id: true },
  });
  const tramiteIds = testTramites.map((tramite) => tramite.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
      ],
    },
  });
  await prisma.estadoLog.deleteMany({
    where: {
      OR: [{ usuarioId: { in: userIds } }, { tramiteId: { in: tramiteIds } }],
    },
  });
  await prisma.checklistItem.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });

  // BorradorFactura/Factura referencian TramiteDO con onDelete: Restrict —
  // hay que limpiarlos antes de borrar los tramites (tests de listTramites
  // crean borradores directos para simular "factura emitida").
  const testBorradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = testBorradores.map((borrador) => borrador.id);

  await prisma.factura.deleteMany({
    where: { borradorId: { in: borradorIds } },
  });
  await prisma.borradorFactura.deleteMany({
    where: { id: { in: borradorIds } },
  });

  await prisma.tramiteDO.deleteMany({
    where: { id: { in: tramiteIds } },
  });
  await prisma.plantillaChecklistItem.deleteMany({
    where: {
      plantilla: {
        nombre: { startsWith: templatePrefix },
      },
    },
  });
  await prisma.plantillaChecklist.deleteMany({
    where: { nombre: { startsWith: templatePrefix } },
  });
  await prisma.cliente.deleteMany({
    where: { id: { in: clienteIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
}

async function createFixture(): Promise<Fixture> {
  await prisma.plantillaChecklist.create({
    data: {
      nombre: `${templatePrefix} ${runId}`,
      items: {
        create: [
          { descripcion: "Factura comercial", requerido: true, orden: 1 },
          { descripcion: "BL", requerido: true, orden: 2 },
          { descripcion: "Packing list", requerido: false, orden: 3 },
        ],
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Tramites",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Tramites",
      nit: `${runId}-nit`,
      tipo: TipoCliente.PROPIO,
      capacidades: { create: SIN_REQUISITOS_DO },
    },
  });

  return { clienteId: cliente.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de tramites",
    );
    throw new Error("Test omitido porque la BD local no esta disponible");
  }

  return fixture;
}

function createInput(overrides: Partial<Parameters<typeof createTramite>[0]> = {}) {
  if (!fixture) {
    throw new Error("Fixture de BD no inicializado");
  }

  return {
    ciudad: Ciudad.BAQ,
    anio: stateYear,
    clienteId: fixture.clienteId,
    agenciaAduanas: AgenciaAduanas.COLDEX,
    creadoPorId: fixture.userId,
    comentarios: `${TEST_PREFIX}:${runId}`,
    ...overrides,
  };
}

describe("formatConsecutivo", () => {
  it("formatea ciudad, ultimos dos digitos del anio y numero con cuatro digitos", () => {
    expect(formatConsecutivo(IMPORTACION, Ciudad.CTG, 2026, 1)).toBe("DO.CTG26-0001");
    expect(formatConsecutivo(IMPORTACION, Ciudad.BUN, 2026, 26)).toBe("DO.BUN26-0026");
    expect(formatConsecutivo(IMPORTACION, Ciudad.SMR, 2099, 1234)).toBe(
      "DO.SMR99-1234",
    );
  });
});

describe("tramites service con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason =
        "DATABASE_URL no esta definida; se omiten tests de integracion con Postgres";
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
    if (dbConnected) {
      await cleanupTestData();
    }

    await prisma.$disconnect();
  });

  it("rechaza una transicion invalida", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await createTramite(
      createInput({
        ciudad: Ciudad.BAQ,
        anio: stateYear,
        creadoPorId: db.userId,
      }),
    );

    const result = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      db.userId,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: "Transicion invalida: SOLICITUD -> EN_TRAMITE",
    });

    const persisted = await prisma.tramiteDO.findUnique({
      where: { id: tramite.id },
      select: { estado: true },
    });
    expect(persisted?.estado).toBe(EstadoTramite.SOLICITUD);
  });

  it("bloquea APERTURA -> EN_TRAMITE cuando falta checklist requerido", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite = await createTramite(
      createInput({
        ciudad: Ciudad.CTG,
        anio: stateYear,
        creadoPorId: db.userId,
      }),
    );

    await prisma.tramiteDO.update({
      where: { id: tramite.id },
      data: { estado: EstadoTramite.APERTURA },
    });

    const result = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      db.userId,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: "Checklist requerido incompleto",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      expect.fail("La transicion debio ser rechazada");
    }
    expect(result.faltantes?.slice().sort()).toEqual([
      "BL",
      "Factura comercial",
    ]);

    const persisted = await prisma.tramiteDO.findUnique({
      where: { id: tramite.id },
      select: { estado: true },
    });
    expect(persisted?.estado).toBe(EstadoTramite.APERTURA);
  });

  it("la agencia fija solo se exige a los tipos que llevan agencia", async (ctx) => {
    const db = ensureDb(ctx);
    // Empresa aparte con la regla de Litoplas: en el cliente del fixture
    // rompería los demás tests (crean importaciones con COLDEX).
    const empresa = await prisma.cliente.create({
      data: {
        nombre: "Cliente Vitest Regla Agencia",
        nit: `${runId}-regla`,
        tipo: TipoCliente.PROPIO,
        capacidades: {
          create: [
            ...SIN_REQUISITOS_DO,
            { codigo: "clasificacion_arancelaria", habilitado: true },
            {
              codigo: "regla_agencia_fija",
              habilitado: true,
              config: { agencia: "MOVIADUANAS", formatoDoAgencia: "^I\\d{8}$" },
            },
          ],
        },
      },
    });

    const clasificacion = await createTramite(
      createInput({
        clienteId: empresa.id,
        creadoPorId: db.userId,
        tipoTramiteCodigo: "CLASIFICACION",
        agenciaAduanas: undefined,
        referenciaExterna: "2140",
      }),
    );
    await prisma.tramiteDO.update({
      where: { id: clasificacion.id },
      data: { estado: EstadoTramite.APERTURA },
    });
    const avanza = await transitionTramite(
      clasificacion.id,
      EstadoTramite.EN_TRAMITE,
      db.userId,
    );
    expect(avanza.ok).toBe(true);

    const importacion = await createTramite(
      createInput({
        clienteId: empresa.id,
        creadoPorId: db.userId,
        agenciaAduanas: AgenciaAduanas.MOVIADUANAS,
        doAgencia: "I26030171",
      }),
    );
    await prisma.tramiteDO.update({
      where: { id: importacion.id },
      data: { estado: EstadoTramite.APERTURA, doAgencia: "SIN-FORMATO" },
    });
    const bloqueada = await transitionTramite(
      importacion.id,
      EstadoTramite.EN_TRAMITE,
      db.userId,
      true,
    );
    expect(bloqueada).toMatchObject({ ok: false, status: 422 });
  });

  it("F1 — rechaza crear un DO para una empresa marcada solo como proveedor", async (ctx) => {
    const db = ensureDb(ctx);

    // Caso ALMACARGA / EXPRESS LOGISTICA: empresa solo-proveedor, sin rol
    // cliente. Aunque la UI ya filtre el selector con `rol=cliente`, el
    // servicio debe rechazarla igual.
    const soloProveedor = await prisma.cliente.create({
      data: {
        nombre: "Empresa Solo Proveedor Vitest",
        nit: `${runId}-solo-proveedor`,
        tipo: TipoCliente.PROPIO,
        esCliente: false,
        esProveedor: true,
        capacidades: { create: SIN_REQUISITOS_DO },
      },
    });

    await expect(
      createTramite(
        createInput({
          clienteId: soloProveedor.id,
          creadoPorId: db.userId,
        }),
      ),
    ).rejects.toMatchObject({
      name: "EmpresaNoEsClienteError",
      status: 422,
      message:
        "Empresa Solo Proveedor Vitest está marcada solo como proveedor. Márcala como cliente en su ficha para abrirle trámites.",
    });
  });

  it("crea 20 tramites concurrentes sin consecutivos duplicados ni saltos", async (ctx) => {
    const db = ensureDb(ctx);
    const ciudad = Ciudad.SMR;
    const cantidad = 20;

    const tramites = await Promise.all(
      Array.from({ length: cantidad }, (_, index) =>
        createTramite(
          createInput({
            ciudad,
            anio: concurrencyYear,
            creadoPorId: db.userId,
            comentarios: `${TEST_PREFIX}:${runId}:concurrency:${index}`,
          }),
        ),
      ),
    );

    const ordered = [...tramites].sort((a, b) => a.numero - b.numero);
    const numeros = ordered.map((tramite) => tramite.numero);
    const expectedNumeros = Array.from(
      { length: cantidad },
      (_, index) => numeros[0] + index,
    );

    expect(new Set(numeros)).toHaveLength(cantidad);
    expect(numeros).toEqual(expectedNumeros);
    expect(new Set(ordered.map((tramite) => tramite.consecutivo))).toHaveLength(
      cantidad,
    );
    expect(ordered.map((tramite) => tramite.consecutivo)).toEqual(
      ordered.map((tramite) =>
        formatConsecutivo(IMPORTACION, ciudad, concurrencyYear, tramite.numero),
      ),
    );
  });

  describe("listTramites - filtros de listado", () => {
    const listAnio = 2097;
    let clientePropioId: string | null = null;
    let clienteSocioId: string | null = null;

    beforeAll(async () => {
      if (!fixture) {
        return;
      }

      const propio = await prisma.cliente.create({
        data: {
          nombre: "Cliente Vitest Filtros Propio",
          nit: `${runId}-list-propio`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: SIN_REQUISITOS_DO },
        },
      });
      const socio = await prisma.cliente.create({
        data: {
          nombre: "Cliente Vitest Filtros Socio",
          nit: `${runId}-list-socio`,
          tipo: TipoCliente.SOCIO_LM,
          capacidades: { create: SIN_REQUISITOS_DO },
        },
      });

      clientePropioId = propio.id;
      clienteSocioId = socio.id;
    });

    function crearListInput(
      overrides: Partial<Parameters<typeof createTramite>[0]> = {},
    ) {
      const db = fixture;
      if (!db || !clientePropioId) {
        throw new Error("Fixture de filtros no inicializado");
      }

      return {
        ciudad: Ciudad.BAQ,
        anio: listAnio,
        clienteId: clientePropioId,
        agenciaAduanas: AgenciaAduanas.COLDEX,
        creadoPorId: db.userId,
        comentarios: `${TEST_PREFIX}:${runId}:list`,
        ...overrides,
      };
    }

    it("filtra por estado", async (ctx) => {
      const db = ensureDb(ctx);
      const enPuerto = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:estado:en-puerto` }),
      );
      await prisma.tramiteDO.update({
        where: { id: enPuerto.id },
        data: { estado: EstadoTramite.EN_PUERTO },
      });
      const solicitud = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:estado:solicitud` }),
      );

      const result = await listTramites(
        { estado: EstadoTramite.EN_PUERTO, clienteId: clientePropioId!, take: 500 },
        {},
      );
      const ids = result.tramites.map((tramite) => tramite.id);

      expect(ids).toContain(enPuerto.id);
      expect(ids).not.toContain(solicitud.id);
      void db;
    });

    it("filtra por ciudad", async (ctx) => {
      const db = ensureDb(ctx);
      const baq = await createTramite(
        crearListInput({
          ciudad: Ciudad.BAQ,
          comentarios: `${TEST_PREFIX}:${runId}:list:ciudad:baq`,
        }),
      );
      const ctg = await createTramite(
        crearListInput({
          ciudad: Ciudad.CTG,
          comentarios: `${TEST_PREFIX}:${runId}:list:ciudad:ctg`,
        }),
      );

      const result = await listTramites(
        { ciudad: Ciudad.BAQ, clienteId: clientePropioId!, take: 500 },
        {},
      );
      const ids = result.tramites.map((tramite) => tramite.id);

      expect(ids).toContain(baq.id);
      expect(ids).not.toContain(ctg.id);
      void db;
    });

    it("filtra por clienteId", async (ctx) => {
      const db = ensureDb(ctx);
      const propio = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:clienteId:propio` }),
      );
      const socio = await createTramite(
        crearListInput({
          clienteId: clienteSocioId!,
          comentarios: `${TEST_PREFIX}:${runId}:list:clienteId:socio`,
        }),
      );

      const result = await listTramites(
        { clienteId: clienteSocioId!, take: 500 },
        {},
      );
      const ids = result.tramites.map((tramite) => tramite.id);

      expect(ids).toContain(socio.id);
      expect(ids).not.toContain(propio.id);
      void db;
    });

    it("filtra por tipoCliente (PROPIO vs SOCIO_LM)", async (ctx) => {
      const db = ensureDb(ctx);
      const propio = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:tipoCliente:propio` }),
      );
      const socio = await createTramite(
        crearListInput({
          clienteId: clienteSocioId!,
          comentarios: `${TEST_PREFIX}:${runId}:list:tipoCliente:socio`,
        }),
      );

      const result = await listTramites(
        { tipoCliente: TipoCliente.SOCIO_LM, take: 500 },
        {},
      );
      const ids = result.tramites.map((tramite) => tramite.id);

      expect(ids).toContain(socio.id);
      expect(ids).not.toContain(propio.id);
      void db;
    });

    it("filtra por facturado=true cuando el estado ya es terminal (FACTURADO/PAGADO/CERRADO)", async (ctx) => {
      const db = ensureDb(ctx);
      const pagado = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:facturado:pagado` }),
      );
      await prisma.tramiteDO.update({
        where: { id: pagado.id },
        data: { estado: EstadoTramite.PAGADO },
      });
      const solicitud = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:facturado:solicitud-a` }),
      );

      const facturados = await listTramites(
        { clienteId: clientePropioId!, facturado: true, take: 500 },
        {},
      );
      const noFacturados = await listTramites(
        { clienteId: clientePropioId!, facturado: false, take: 500 },
        {},
      );

      expect(facturados.tramites.map((t) => t.id)).toContain(pagado.id);
      expect(facturados.tramites.map((t) => t.id)).not.toContain(solicitud.id);
      expect(noFacturados.tramites.map((t) => t.id)).toContain(solicitud.id);
      expect(noFacturados.tramites.map((t) => t.id)).not.toContain(pagado.id);
      void db;
    });

    it("filtra por facturado=true cuando existe un borrador FACTURADO aunque el estado del tramite no sea terminal", async (ctx) => {
      const db = ensureDb(ctx);
      const conBorrador = await createTramite(
        crearListInput({
          comentarios: `${TEST_PREFIX}:${runId}:list:facturado:borrador`,
        }),
      );
      await prisma.tramiteDO.update({
        where: { id: conBorrador.id },
        data: { estado: EstadoTramite.DESPACHADO },
      });
      await prisma.borradorFactura.create({
        data: {
          tramiteId: conBorrador.id,
          comision: 0n,
          ivaComision: 0n,
          impuesto4x1000: 0n,
          costosBancarios: 0n,
          totalAnticipo: 0n,
          totalPagos: 0n,
          totalFactura: 0n,
          estado: EstadoBorrador.FACTURADO,
        },
      });

      const facturados = await listTramites(
        { clienteId: clientePropioId!, facturado: true, take: 500 },
        {},
      );
      const noFacturados = await listTramites(
        { clienteId: clientePropioId!, facturado: false, take: 500 },
        {},
      );

      expect(facturados.tramites.map((t) => t.id)).toContain(conBorrador.id);
      expect(noFacturados.tramites.map((t) => t.id)).not.toContain(conBorrador.id);
      void db;
    });

    it("busca por q (contains case-insensitive sobre el consecutivo)", async (ctx) => {
      const db = ensureDb(ctx);
      const tramite = await createTramite(
        crearListInput({ comentarios: `${TEST_PREFIX}:${runId}:list:q` }),
      );

      const result = await listTramites(
        { q: tramite.consecutivo.toLowerCase(), take: 500 },
        {},
      );
      const ids = result.tramites.map((t) => t.id);

      expect(ids).toContain(tramite.id);
      void db;
    });

    it("el scoping SOCIO nunca se debilita: tipoCliente=PROPIO combinado con socioScope da vacio", async (ctx) => {
      const db = ensureDb(ctx);
      const propio = await createTramite(
        crearListInput({
          comentarios: `${TEST_PREFIX}:${runId}:list:socioscope:propio`,
        }),
      );

      const result = await listTramites(
        { tipoCliente: TipoCliente.PROPIO, take: 500 },
        { socioScope: true },
      );
      const ids = result.tramites.map((t) => t.id);

      expect(ids).not.toContain(propio.id);
      void db;
    });

    it("socioScope limita a clientes SOCIO_LM incluso sin filtro explicito de tipoCliente", async (ctx) => {
      const db = ensureDb(ctx);
      const propio = await createTramite(
        crearListInput({
          comentarios: `${TEST_PREFIX}:${runId}:list:socioscope:sin-filtro-propio`,
        }),
      );
      const socio = await createTramite(
        crearListInput({
          clienteId: clienteSocioId!,
          comentarios: `${TEST_PREFIX}:${runId}:list:socioscope:sin-filtro-socio`,
        }),
      );

      const result = await listTramites({ take: 500 }, { socioScope: true });
      const ids = result.tramites.map((t) => t.id);

      expect(ids).toContain(socio.id);
      expect(ids).not.toContain(propio.id);
      void db;
    });
  });

  // A8 — Columnas ordenables del listado (revisión de Ernesto, 22-sep-2026).
  // El builder puro (`construirOrdenTramites`) ya se prueba exhaustivamente
  // sin BD en `orden.test.ts`; aquí solo se confirma el cableado end-to-end
  // con Postgres para dos columnas representativas (relación y enum).
  describe("listTramites - orden (A8)", () => {
    it("ordenarPor=cliente ordena por el nombre de la empresa (asc)", async (ctx) => {
      const db = ensureDb(ctx);
      const token = `${runId}-orden-cliente`;
      const zebra = await prisma.cliente.create({
        data: {
          nombre: `Zebra Vitest ${token}`,
          nit: `${token}-z`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: SIN_REQUISITOS_DO },
        },
      });
      const alfa = await prisma.cliente.create({
        data: {
          nombre: `Alfa Vitest ${token}`,
          nit: `${token}-a`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: SIN_REQUISITOS_DO },
        },
      });

      await createTramite(
        createInput({ clienteId: zebra.id, comentarios: `${TEST_PREFIX}:${runId}:orden:cliente:zebra` }),
      );
      await createTramite(
        createInput({ clienteId: alfa.id, comentarios: `${TEST_PREFIX}:${runId}:orden:cliente:alfa` }),
      );

      const result = await listTramites(
        { q: token, ordenarPor: "cliente", direccion: "asc", take: 10 },
        {},
      );

      expect(result.tramites.map((t) => t.cliente.nombre)).toEqual([
        `Alfa Vitest ${token}`,
        `Zebra Vitest ${token}`,
      ]);
      void db;
    });

    it("ordenarPor=estado ordena por el pipeline (SOLICITUD antes que EN_PUERTO)", async (ctx) => {
      const db = ensureDb(ctx);
      const cliente = await prisma.cliente.create({
        data: {
          nombre: `Cliente Vitest Orden Estado ${runId}`,
          nit: `${runId}-orden-estado`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: SIN_REQUISITOS_DO },
        },
      });

      const enPuerto = await createTramite(
        createInput({ clienteId: cliente.id, comentarios: `${TEST_PREFIX}:${runId}:orden:estado:en-puerto` }),
      );
      await prisma.tramiteDO.update({
        where: { id: enPuerto.id },
        data: { estado: EstadoTramite.EN_PUERTO },
      });
      const solicitud = await createTramite(
        createInput({ clienteId: cliente.id, comentarios: `${TEST_PREFIX}:${runId}:orden:estado:solicitud` }),
      );

      const result = await listTramites(
        { clienteId: cliente.id, ordenarPor: "estado", direccion: "asc", take: 10 },
        {},
      );

      expect(result.tramites.map((t) => t.id)).toEqual([solicitud.id, enPuerto.id]);
      void db;
    });

    it("sin ordenarPor mantiene el orden de siempre (el que usa la vista kanban)", async (ctx) => {
      const db = ensureDb(ctx);
      const cliente = await prisma.cliente.create({
        data: {
          nombre: `Cliente Vitest Orden Defecto ${runId}`,
          nit: `${runId}-orden-defecto`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: SIN_REQUISITOS_DO },
        },
      });
      const primero = await createTramite(
        createInput({
          clienteId: cliente.id,
          ciudad: Ciudad.BAQ,
          anio: 2050,
          comentarios: `${TEST_PREFIX}:${runId}:orden:defecto:1`,
        }),
      );
      const segundo = await createTramite(
        createInput({
          clienteId: cliente.id,
          ciudad: Ciudad.BAQ,
          anio: 2050,
          comentarios: `${TEST_PREFIX}:${runId}:orden:defecto:2`,
        }),
      );

      const result = await listTramites({ clienteId: cliente.id, take: 10 }, {});

      // Orden de siempre: numero desc -> el ultimo creado primero.
      expect(result.tramites.map((t) => t.id)).toEqual([segundo.id, primero.id]);
      void db;
    });
  });
});
