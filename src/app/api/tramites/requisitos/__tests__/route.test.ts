/**
 * Requisitos del DO por HTTP (integración con BD local):
 *
 *   GET  /api/tramites/requisitos          — contrato para la UI, roles y validación
 *   POST /api/tramites                     — 422 con `codigo` y `detalles` sin tarifa
 *   POST /api/tramites/[id]/estado         — 422 por documentos / advertencias del ADMIN
 *   POST /api/solicitudes                  — la solicitud pública entra sin tarifa
 *
 * Se omite solo si no hay BD (mismo patrón que el resto de tests de rutas).
 */

import "dotenv/config";

import { EstadoTarifario, EstadoTramite, Prisma, Rol } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ── Mocks de autenticación ────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

// ── Importaciones post-mock ───────────────────────────────────────────────────

import { POST as solicitudesPOST } from "@/app/api/solicitudes/route";
import { POST as estadoPOST } from "@/app/api/tramites/[id]/estado/route";
import { GET as requisitosGET } from "@/app/api/tramites/requisitos/route";
import { POST as tramitesPOST } from "@/app/api/tramites/route";
import { auth } from "@/lib/auth/auth";
import { definicionDe } from "@/lib/capacidades/catalogo";
import { prisma } from "@/lib/db/prisma";

// ── Estado ────────────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-requisitos-api";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DIA = 86_400_000;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresas = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD no disponible");
  }
}

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Requisitos API",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-requisitos",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + DIA),
      token: "token-requisitos",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function comoRol(rol: Rol | null) {
  vi.mocked(auth.api.getSession).mockResolvedValue(rol ? sesion(rol) : null);
}

function requisitosRequest(params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost/api/tramites/requisitos?${query}`);
}

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function crearEmpresa(
  capacidades: { codigo: string; habilitado: boolean; config?: Prisma.InputJsonValue }[] = [],
) {
  empresas += 1;
  return prisma.cliente.create({
    data: {
      nombre: `EMPRESA VITEST REQUISITOS API ${empresas}`,
      nit: `${RUN_ID}-${empresas}`,
      capacidades: { create: capacidades },
    },
  });
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);

  await prisma.auditLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.auditLog.deleteMany({ where: { usuario: { email: { startsWith: TEST_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de requisitos por HTTP";
    return;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  const catalogo = await prisma.capacidad.count({
    where: { codigo: { in: ["do_exige_tarifa_vigente", "docs_bl_factura_obligatorios"] } },
  });
  if (catalogo < 2) {
    dbUnavailableReason =
      "Faltan las capacidades de requisitos: aplica la migración 20260923092000_capacidades_requisitos_do";
    return;
  }

  // Igual que el seed en cada arranque: el catálogo de BD refleja el del código.
  for (const codigo of ["do_exige_tarifa_vigente", "docs_bl_factura_obligatorios"] as const) {
    const definicion = definicionDe(codigo);
    await prisma.capacidad.update({
      where: { codigo },
      data: {
        porDefecto: definicion.porDefecto,
        configPorDefecto:
          definicion.configPorDefecto === null
            ? Prisma.DbNull
            : (definicion.configPorDefecto as Prisma.InputJsonValue),
        activa: true,
      },
    });
  }

  dbConnected = true;
  await limpiar();

  const usuario = await prisma.user.create({
    data: {
      email: `${RUN_ID}@example.test`,
      emailVerified: true,
      name: "Vitest Requisitos API",
      rol: Rol.ADMIN,
    },
  });
  usuarioId = usuario.id;
});

afterAll(async () => {
  if (dbConnected) {
    await limpiar();
  }
  await prisma.$disconnect();
});

// ── GET /api/tramites/requisitos ──────────────────────────────────────────────

describe("GET /api/tramites/requisitos — acceso y validación", () => {
  it("401 sin sesión y 403 para SOCIO", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();

    comoRol(null);
    expect((await requisitosGET(requisitosRequest({ clienteId: empresa.id }))).status).toBe(401);

    comoRol(Rol.SOCIO);
    expect((await requisitosGET(requisitosRequest({ clienteId: empresa.id }))).status).toBe(403);
  });

  it("400 sin empresa, con el mensaje en español", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);

    const response = await requisitosGET(requisitosRequest({}));
    const payload = (await response.json()) as { details: { campo: string; mensaje: string }[] };

    expect(response.status).toBe(400);
    expect(payload.details).toContainEqual({ campo: "clienteId", mensaje: "Indica la empresa del DO." });
  });

  it("404 si la empresa no existe y 422 si el tipo de trámite no existe", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa();

    const sinEmpresa = await requisitosGET(requisitosRequest({ clienteId: `${RUN_ID}-no-existe` }));
    expect(sinEmpresa.status).toBe(404);
    expect(await sinEmpresa.json()).toEqual({ error: "Empresa no encontrada" });

    const sinTipo = await requisitosGET(
      requisitosRequest({ clienteId: empresa.id, tipoTramiteCodigo: "NO_EXISTE" }),
    );
    expect(sinTipo.status).toBe(422);
  });

  it.for([Rol.ADMIN, Rol.REVISOR, Rol.OPERATIVO])("%s puede consultarlo", async (rol, ctx) => {
    ensureDb(ctx);
    comoRol(rol);
    const empresa = await crearEmpresa();

    const response = await requisitosGET(requisitosRequest({ clienteId: empresa.id }));

    expect(response.status).toBe(200);
  });
});

describe("GET /api/tramites/requisitos — contrato", () => {
  it("empresa por defecto sin tarifa: exigida, no cumple, pide BL y factura", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);

    const response = await requisitosGET(requisitosRequest({ clienteId: empresa.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tarifaVigente: {
        requerida: true,
        cumple: false,
        lineaServicio: "TRAMITE",
        tarifario: null,
        tarifarioPropioHabilitado: true,
        mensaje: `${empresa.nombre} no tiene una tarifa vigente de importación. Publica la tarifa de la empresa antes de crear el DO.`,
      },
      documentosObligatorios: { requeridos: ["BL", "FACTURA_COMERCIAL"] },
    });
  });

  it("con tarifa vigente: cumple y devuelve id, nombre, versión y vigencia", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.REVISOR);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    const vigenteHasta = new Date(Date.now() + 60 * DIA);
    const tarifario = await prisma.tarifario.create({
      data: {
        empresaId: empresa.id,
        nombre: "Tarifas vitest importaciones",
        alcance: "TRAMITE",
        estado: EstadoTarifario.VIGENTE,
        vigenteDesde: new Date(Date.now() - 10 * DIA),
        vigenteHasta,
        version: 2,
        creadoPorId: usuarioId,
      },
    });

    const response = await requisitosGET(
      requisitosRequest({ clienteId: empresa.id, tipoTramiteCodigo: "IMPORTACION" }),
    );
    const payload = (await response.json()) as { tarifaVigente: Record<string, unknown> };

    expect(payload.tarifaVigente).toEqual({
      requerida: true,
      cumple: true,
      lineaServicio: "TRAMITE",
      tarifario: {
        id: tarifario.id,
        nombre: "Tarifas vitest importaciones",
        version: 2,
        vigenteHasta: vigenteHasta.toISOString(),
      },
      tarifarioPropioHabilitado: true,
      mensaje: null,
    });
  });

  it("clasificación: su propia línea de servicio y sin BL por defecto", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa();

    const response = await requisitosGET(
      requisitosRequest({ clienteId: empresa.id, tipoTramiteCodigo: "CLASIFICACION" }),
    );
    const payload = (await response.json()) as {
      tarifaVigente: { lineaServicio: string; requerida: boolean };
      documentosObligatorios: { requeridos: string[] };
    };

    expect(payload.tarifaVigente).toMatchObject({ lineaServicio: "CLASIFICACION", requerida: true });
    expect(payload.documentosObligatorios.requeridos).toEqual([]);
  });

  it("empresa con las dos funciones apagadas (caso socio): nada exigido", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa([
      { codigo: "do_exige_tarifa_vigente", habilitado: false },
      { codigo: "docs_bl_factura_obligatorios", habilitado: false },
    ]);

    const response = await requisitosGET(requisitosRequest({ clienteId: empresa.id }));

    expect(await response.json()).toMatchObject({
      tarifaVigente: { requerida: false, cumple: true, mensaje: null },
      documentosObligatorios: { requeridos: [] },
    });
  });
});

// ── Creación y transición por HTTP ────────────────────────────────────────────

describe("POST /api/tramites y /estado con los requisitos", () => {
  it("crear sin tarifa vigente: 422 con código y detalles para ir a la tarifa", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa();

    const response = await tramitesPOST(
      jsonRequest("http://localhost/api/tramites", {
        ciudad: "SMR",
        anio: 2095,
        clienteId: empresa.id,
        agenciaAduanas: "COLDEX",
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      codigo: "TARIFA_VIGENTE_REQUERIDA",
      detalles: { clienteId: empresa.id, lineaServicio: "TRAMITE", tipoTramiteCodigo: "IMPORTACION" },
    });
  });

  it("OPERATIVO sin documentos: 422 con código; ADMIN pasa con advertencias", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "do_exige_tarifa_vigente", habilitado: false }]);

    comoRol(Rol.OPERATIVO);
    const creado = await tramitesPOST(
      jsonRequest("http://localhost/api/tramites", {
        ciudad: "SMR",
        anio: 2095,
        clienteId: empresa.id,
        agenciaAduanas: "COLDEX",
      }),
    );
    expect(creado.status).toBe(201);
    const { tramite } = (await creado.json()) as { tramite: { id: string; consecutivo: string } };
    await prisma.checklistItem.updateMany({ where: { tramiteId: tramite.id }, data: { recibido: true } });
    await prisma.tramiteDO.update({ where: { id: tramite.id }, data: { estado: EstadoTramite.APERTURA } });

    const contexto = { params: Promise.resolve({ id: tramite.id }) };
    const url = `http://localhost/api/tramites/${tramite.id}/estado`;

    const bloqueado = await estadoPOST(jsonRequest(url, { estado: "EN_TRAMITE" }), contexto);
    expect(bloqueado.status).toBe(422);
    expect(await bloqueado.json()).toMatchObject({
      error: `Falta el BL y la factura comercial del ${tramite.consecutivo}.`,
      codigo: "DOCUMENTOS_OBLIGATORIOS_FALTANTES",
      detalles: { documentosFaltantes: ["BL", "FACTURA_COMERCIAL"] },
    });

    comoRol(Rol.ADMIN);
    const forzado = await estadoPOST(jsonRequest(url, { estado: "EN_TRAMITE" }), contexto);
    const payload = (await forzado.json()) as { advertencias: string[] };
    expect(forzado.status).toBe(200);
    expect(payload.advertencias).toHaveLength(1);
    expect(payload.advertencias[0]).toContain("Pasó por excepción de ADMIN");
  });
});

describe("POST /api/solicitudes (público)", () => {
  it("la solicitud externa entra aunque la empresa no tenga tarifa", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();

    const response = await solicitudesPOST(
      jsonRequest("http://localhost/api/solicitudes", {
        nit: empresa.nit,
        ciudad: "SMR",
        agenciaAduanas: "COLDEX",
      }),
    );

    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const tramite = await prisma.tramiteDO.findUniqueOrThrow({ where: { id } });
    expect(tramite.estado).toBe(EstadoTramite.SOLICITUD);
    expect(tramite.clienteId).toBe(empresa.id);
  });
});
