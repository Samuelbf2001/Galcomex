/**
 * M1 — API de capacidades por empresa (integración con BD)
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no está
 * (mismo patrón que el resto de tests de integración del proyecto).
 *
 * Cubre lo que el resolver puro no puede cubrir: persistencia del override,
 * cascada con grupo económico, espejo con `cliente.manejaAnticipo`, AuditLog y
 * permisos por rol.
 */

import "dotenv/config";

import { Rol } from "@prisma/client";
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

import {
  GET as capacidadesGET,
  PUT as capacidadesPUT,
} from "@/app/api/clientes/[id]/capacidades/route";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";

// ── Constantes / estado ───────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-capacidades";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresaId = "";
let empresaEnGrupoId = "";
let grupoId = "";

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Capacidades",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-capacidades",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "token-capacidades",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD no disponible");
  }
}

function routeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getRequest() {
  return new NextRequest("http://localhost/api/clientes/x/capacidades");
}

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/clientes/x/capacidades", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

type CapacidadPayload = {
  codigo: string;
  habilitado: boolean;
  config: Record<string, unknown> | null;
  tieneOverride: boolean;
  origenHabilitado: string;
  origenConfig: string;
};

async function leerCapacidades(id: string): Promise<CapacidadPayload[]> {
  const response = await capacidadesGET(getRequest(), routeCtx(id));
  const payload = (await response.json()) as { capacidades: CapacidadPayload[] };
  return payload.capacidades;
}

function buscar(capacidades: CapacidadPayload[], codigo: string): CapacidadPayload {
  const encontrada = capacidades.find((capacidad) => capacidad.codigo === codigo);
  if (!encontrada) throw new Error(`Capacidad ${codigo} ausente en la respuesta`);
  return encontrada;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de capacidades";
    return;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    // El catálogo lo siembra la migración; sin él no hay nada que probar.
    const catalogo = await prisma.capacidad.count();
    if (catalogo === 0) {
      dbUnavailableReason =
        "Catálogo de capacidades vacío: aplica la migración 20260905120000_capacidades_empresa";
      return;
    }
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }

  const usuario = await prisma.user.create({
    data: {
      email: `${RUN_ID}@example.test`,
      emailVerified: true,
      name: "Vitest Capacidades",
      rol: Rol.ADMIN,
    },
  });
  usuarioId = usuario.id;

  const empresa = await prisma.cliente.create({
    data: { nombre: "Empresa Vitest Capacidades", nit: `${RUN_ID}-a` },
  });
  empresaId = empresa.id;

  const grupo = await prisma.grupoEmpresa.create({
    data: { nombre: `Grupo ${RUN_ID}` },
  });
  grupoId = grupo.id;

  const empresaEnGrupo = await prisma.cliente.create({
    data: {
      nombre: "Empresa Vitest En Grupo",
      nit: `${RUN_ID}-b`,
      grupoEmpresaId: grupo.id,
    },
  });
  empresaEnGrupoId = empresaEnGrupo.id;

  vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
});

afterAll(async () => {
  if (!dbConnected) return;

  const empresaIds = [empresaId, empresaEnGrupoId].filter(Boolean);

  await prisma.auditLog.deleteMany({ where: { usuarioId } });
  // empresa_capacidad y grupo_empresa_capacidad caen por ON DELETE CASCADE.
  await prisma.cliente.deleteMany({ where: { id: { in: empresaIds } } });
  await prisma.grupoEmpresa.deleteMany({ where: { id: grupoId } });
  await prisma.user.deleteMany({ where: { id: usuarioId } });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/clientes/[id]/capacidades", () => {
  it("devuelve el catálogo con los defaults del sistema", async (ctx) => {
    ensureDb(ctx);

    const capacidades = await leerCapacidades(empresaId);

    expect(capacidades.length).toBeGreaterThan(0);

    const anticipos = buscar(capacidades, "anticipos_cliente");
    expect(anticipos.habilitado).toBe(true);
    expect(anticipos.origenHabilitado).toBe("DEFECTO");
    expect(anticipos.tieneOverride).toBe(false);

    const cif = buscar(capacidades, "base_cif");
    expect(cif.habilitado).toBe(false);
  });

  it("404 si la empresa no existe", async (ctx) => {
    ensureDb(ctx);

    const response = await capacidadesGET(getRequest(), routeCtx("no-existe"));
    expect(response.status).toBe(404);
  });
});

describe("PUT /api/clientes/[id]/capacidades", () => {
  it("enciende una capacidad y la deja como override propio", async (ctx) => {
    ensureDb(ctx);

    const response = await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "base_cif", habilitado: true }] }),
      routeCtx(empresaId),
    );

    expect(response.status).toBe(200);

    const cif = buscar(await leerCapacidades(empresaId), "base_cif");
    expect(cif.habilitado).toBe(true);
    expect(cif.origenHabilitado).toBe("EMPRESA");
    expect(cif.tieneOverride).toBe(true);
  });

  it("guarda la config de la capacidad", async (ctx) => {
    ensureDb(ctx);

    await capacidadesPUT(
      putRequest({
        cambios: [
          {
            codigo: "comision_por_evento",
            habilitado: true,
            config: { unidad: "CONTENEDOR", valor: "45000" },
          },
        ],
      }),
      routeCtx(empresaId),
    );

    const comision = buscar(await leerCapacidades(empresaId), "comision_por_evento");
    expect(comision.habilitado).toBe(true);
    expect(comision.config).toEqual({ unidad: "CONTENEDOR", valor: "45000" });
  });

  it("heredar borra el override y vuelve al defecto", async (ctx) => {
    ensureDb(ctx);

    await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "base_cif", heredar: true }] }),
      routeCtx(empresaId),
    );

    const cif = buscar(await leerCapacidades(empresaId), "base_cif");
    expect(cif.habilitado).toBe(false);
    expect(cif.origenHabilitado).toBe("DEFECTO");
    expect(cif.tieneOverride).toBe(false);
  });

  it("mantiene en espejo cliente.manejaAnticipo durante la transición", async (ctx) => {
    ensureDb(ctx);

    await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "anticipos_cliente", habilitado: false }] }),
      routeCtx(empresaId),
    );

    const empresa = await prisma.cliente.findUniqueOrThrow({
      where: { id: empresaId },
      select: { manejaAnticipo: true },
    });
    expect(empresa.manejaAnticipo).toBe(false);

    await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "anticipos_cliente", habilitado: true }] }),
      routeCtx(empresaId),
    );

    const restaurada = await prisma.cliente.findUniqueOrThrow({
      where: { id: empresaId },
      select: { manejaAnticipo: true },
    });
    expect(restaurada.manejaAnticipo).toBe(true);
  });

  it("deja AuditLog de cada capacidad tocada", async (ctx) => {
    ensureDb(ctx);

    const logs = await prisma.auditLog.findMany({
      where: { entidad: "EmpresaCapacidad", usuarioId },
      select: { accion: true, entidadId: true },
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((log) => log.accion === "SET_CAPACIDAD_EMPRESA")).toBe(true);
    expect(logs.some((log) => log.accion === "RESET_CAPACIDAD_EMPRESA")).toBe(true);
    expect(logs.every((log) => log.entidadId.includes(":"))).toBe(true);
  });

  it("rechaza un código que no está en el catálogo", async (ctx) => {
    ensureDb(ctx);

    const response = await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "capacidad_inventada", habilitado: true }] }),
      routeCtx(empresaId),
    );

    expect(response.status).toBe(400);
  });

  it("rechaza un cambio que no dice nada", async (ctx) => {
    ensureDb(ctx);

    const response = await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "base_cif" }] }),
      routeCtx(empresaId),
    );

    expect(response.status).toBe(400);
  });

  it("403 para roles distintos de ADMIN", async (ctx) => {
    ensureDb(ctx);

    vi.mocked(auth.api.getSession).mockResolvedValueOnce(sesion(Rol.OPERATIVO));

    const response = await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "base_cif", habilitado: true }] }),
      routeCtx(empresaId),
    );

    expect(response.status).toBe(403);
  });
});

describe("cascada con grupo económico", () => {
  it("la empresa hereda del grupo y su override propio gana", async (ctx) => {
    ensureDb(ctx);

    await prisma.grupoEmpresaCapacidad.create({
      data: {
        grupoId,
        codigo: "tarifario_propio",
        habilitado: true,
        config: { origen: "grupo" },
      },
    });

    const heredada = buscar(
      await leerCapacidades(empresaEnGrupoId),
      "tarifario_propio",
    );
    expect(heredada.habilitado).toBe(true);
    expect(heredada.origenHabilitado).toBe("GRUPO");
    expect(heredada.tieneOverride).toBe(false);

    await capacidadesPUT(
      putRequest({ cambios: [{ codigo: "tarifario_propio", habilitado: false }] }),
      routeCtx(empresaEnGrupoId),
    );

    const propia = buscar(await leerCapacidades(empresaEnGrupoId), "tarifario_propio");
    expect(propia.habilitado).toBe(false);
    expect(propia.origenHabilitado).toBe("EMPRESA");
    // La config sigue viniendo del grupo: habilitado y config se resuelven aparte.
    expect(propia.origenConfig).toBe("GRUPO");
  });

  it("una empresa fuera del grupo no se ve afectada", async (ctx) => {
    ensureDb(ctx);

    const ajena = buscar(await leerCapacidades(empresaId), "tarifario_propio");
    expect(ajena.habilitado).toBe(false);
    expect(ajena.origenHabilitado).toBe("DEFECTO");
  });
});

describe("config por tipo de trámite (requisitos del DO)", () => {
  it("guarda la lista de tipos de trámite y la devuelve tal cual", async (ctx) => {
    ensureDb(ctx);

    const response = await capacidadesPUT(
      putRequest({
        cambios: [
          {
            codigo: "docs_bl_factura_obligatorios",
            habilitado: true,
            config: { tiposTramite: ["IMPORTACION", "OTRO"] },
          },
        ],
      }),
      routeCtx(empresaId),
    );

    expect(response.status).toBe(200);
    const docs = buscar(await leerCapacidades(empresaId), "docs_bl_factura_obligatorios");
    expect(docs.habilitado).toBe(true);
    expect(docs.config).toEqual({ tiposTramite: ["IMPORTACION", "OTRO"] });
    expect(docs.origenConfig).toBe("EMPRESA");
  });

  it("encendidas por defecto con su config de fábrica", async (ctx) => {
    ensureDb(ctx);

    const capacidades = await leerCapacidades(empresaEnGrupoId);
    const tarifa = buscar(capacidades, "do_exige_tarifa_vigente");
    expect(tarifa.habilitado).toBe(true);
    expect(tarifa.config).toEqual({ tiposTramite: ["IMPORTACION", "CLASIFICACION", "OTRO"] });
  });

  it("rechaza una config que no es una lista de códigos", async (ctx) => {
    ensureDb(ctx);

    for (const config of [
      { tiposTramite: "IMPORTACION" },
      { tiposTramite: ["importacion"] },
      { tiposTramite: ["IMPORTACION", "IMPORTACION"] },
      {},
    ]) {
      const response = await capacidadesPUT(
        putRequest({ cambios: [{ codigo: "do_exige_tarifa_vigente", habilitado: true, config }] }),
        routeCtx(empresaId),
      );
      const payload = (await response.json()) as { details: { campo: string }[] };

      expect(response.status).toBe(400);
      expect(payload.details.some((d) => d.campo.startsWith("cambios.0.config"))).toBe(true);
    }
  });
});
