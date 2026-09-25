/**
 * A1-T2 — API de clientes y tarifario (integración con BD)
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no está.
 * Rol ADMIN mockeado para todos los tests de mutación.
 * Usa TEST_PREFIX "vitest-clientes-api" en NIT para cleanup seguro.
 */

import "dotenv/config";

import { TipoCliente } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

// ── Mocks de autenticación ─────────────────────────────────────────────────────

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

// ── Importaciones post-mock ────────────────────────────────────────────────────

import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { GET as clientesGET, POST as clientesPOST } from "@/app/api/clientes/route";
import { GET as clienteByIdGET, PATCH as clientePATCH } from "@/app/api/clientes/[id]/route";

// ── Setup: sesión ADMIN siempre activa ────────────────────────────────────────

const ADMIN_SESSION = {
  user: {
    id: "admin-test-user",
    rol: "ADMIN" as Rol,
    email: "admin@test.galcomex",
    name: "Admin Test",
    emailVerified: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
  session: {
    id: "admin-session-id",
    userId: "admin-test-user",
    expiresAt: new Date(Date.now() + 86_400_000),
    token: "admin-token",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ipAddress: null as string | null | undefined,
    userAgent: null as string | null | undefined,
  },
};

// ── Constantes ────────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-clientes-api";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── Estado BD ─────────────────────────────────────────────────────────────────

let dbConnected = false;
let dbUnavailableReason: string | null = null;
const createdClienteIds: string[] = [];

// ── Helpers ────────────────────────────────────────────────────────────────────

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD no disponible");
  }
}

function makeRequest(
  url: string,
  options?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(`http://localhost${url}`, options);
}

function routeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function nit(suffix: string) {
  return `${RUN_ID}-${suffix}`;
}

async function postCliente(body: unknown): Promise<Response> {
  return clientesPOST(
    makeRequest("/api/clientes", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function patchCliente(id: string, body: unknown): Promise<Response> {
  return clientePATCH(
    makeRequest(`/api/clientes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    routeCtx(id),
  );
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Siempre usar sesión ADMIN
  vi.mocked(auth.api.getSession).mockResolvedValue(ADMIN_SESSION);

  if (!process.env.DATABASE_URL) {
    dbUnavailableReason =
      "DATABASE_URL no definida; se omiten tests de integración de clientes";
    return;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${unavailableMessage(error)}`;
  }
});

afterAll(async () => {
  if (!dbConnected) return;

  // Limpieza en orden de dependencias (FK: tarifas→clientes)
  if (createdClienteIds.length > 0) {
    await prisma.tarifaCliente.deleteMany({
      where: { clienteId: { in: createdClienteIds } },
    });
    await prisma.cliente.deleteMany({
      where: { id: { in: createdClienteIds } },
    });
  }

  // Limpieza extra por NIT prefix (por si algún test insertó sin registrar ID)
  const extraClientes = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  if (extraClientes.length > 0) {
    const ids = extraClientes.map((c) => c.id);
    // F1: algunos tests marcan esProveedor=true, lo que crea un Beneficiario
    // enlazado (`asegurarBeneficiarioDeEmpresa`).
    await prisma.beneficiario.deleteMany({ where: { empresaId: { in: ids } } });
    await prisma.tarifaCliente.deleteMany({ where: { clienteId: { in: ids } } });
    await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("A1-T2 — API /api/clientes (integración BD)", () => {
  // ── POST con payload inválido → 400 ─────────────────────────────────────────

  describe("POST — validación Zod", () => {
    it("NIT vacío → 400 con mensaje claro", async (ctx) => {
      ensureDb(ctx);

      const res = await postCliente({ nombre: "Cliente Válido", nit: "" });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; details: { campo: string; mensaje: string }[] };
      expect(body.error).toBe("Payload invalido");
      const nitIssue = body.details.find((d) => d.campo === "nit");
      expect(nitIssue).toBeDefined();
      expect(nitIssue?.mensaje).toMatch(/obligatorio/i);
    });

    it("tarifa con valor negativo → 400 con mensaje claro en details", async (ctx) => {
      ensureDb(ctx);

      const res = await postCliente({
        nombre: "Cliente Válido",
        nit: nit("neg-tarifa"),
        tarifas: [
          { anio: 2026, tipo: "fijo", valor: -1 },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; details: { campo: string; mensaje: string }[] };
      expect(body.error).toBe("Payload invalido");
      // Debe haber al menos un issue con el mensaje de tarifa negativa
      const tarifaIssue = body.details.find((d) =>
        d.mensaje.toLowerCase().includes("negativa") ||
        d.campo.includes("valor"),
      );
      expect(tarifaIssue).toBeDefined();
    });

    it("nombre vacío → 400", async (ctx) => {
      ensureDb(ctx);

      const res = await postCliente({ nombre: "", nit: nit("nombre-vacio") });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; details: unknown[] };
      expect(body.error).toBe("Payload invalido");
    });
  });

  // ── POST válido + GET /[id] con tarifas ──────────────────────────────────────

  describe("POST válido + GET /[id] — crea con tarifa 2026 y la retorna", () => {
    it("crea cliente con tarifa 2026 y GET /[id] lo retorna con la tarifa correcta", async (ctx) => {
      ensureDb(ctx);

      const nitValue = nit("crea-con-tarifa");
      const payload = {
        nombre: "Cliente Test Tarifa 2026",
        nit: nitValue,
        tipo: TipoCliente.PROPIO,
        tarifas: [
          { anio: 2026, tipo: "fijo", valor: 150000 },
        ],
      };

      // POST
      const postRes = await postCliente(payload);
      expect(postRes.status).toBe(201);
      const postBody = await postRes.json() as { cliente: { id: string; nit: string; tarifas: { anio: number; valor: string }[] } };
      expect(postBody.cliente.nit).toBe(nitValue);
      expect(postBody.cliente.tarifas).toHaveLength(1);
      expect(postBody.cliente.tarifas[0].anio).toBe(2026);
      // BigInt se serializa como string
      expect(postBody.cliente.tarifas[0].valor).toBe("150000");

      const clienteId = postBody.cliente.id;
      createdClienteIds.push(clienteId);

      // GET /[id]
      const getRes = await clienteByIdGET(
        makeRequest(`/api/clientes/${clienteId}`),
        routeCtx(clienteId),
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { cliente: { id: string; tarifas: { anio: number; valor: string }[] } };
      expect(getBody.cliente.id).toBe(clienteId);

      const tarifa2026 = getBody.cliente.tarifas.find((t) => t.anio === 2026);
      expect(tarifa2026).toBeDefined();
      expect(tarifa2026?.valor).toBe("150000");
    });
  });

  // ── GET ?tipo=socio_lm filtra correctamente ──────────────────────────────────

  describe("GET /api/clientes?tipo=socio_lm — solo retorna SOCIO_LM", () => {
    it("filtra correctamente: retorna SOCIO_LM y no incluye PROPIO", async (ctx) => {
      ensureDb(ctx);

      // Sembrar un cliente PROPIO y uno SOCIO_LM con TEST_PREFIX en NIT
      const nitPropio = nit("tipo-propio");
      const nitSocio = nit("tipo-socio-lm");

      const [propio, socio] = await Promise.all([
        prisma.cliente.create({
          data: { nombre: "Propio Vitest", nit: nitPropio, tipo: TipoCliente.PROPIO },
        }),
        prisma.cliente.create({
          data: { nombre: "Socio LM Vitest", nit: nitSocio, tipo: TipoCliente.SOCIO_LM },
        }),
      ]);
      createdClienteIds.push(propio.id, socio.id);

      // GET ?tipo=socio_lm
      const res = await clientesGET(
        makeRequest("/api/clientes?tipo=socio_lm"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { clientes: { id: string; tipo: string }[] };

      const ids = body.clientes.map((c) => c.id);
      expect(ids).toContain(socio.id);
      expect(ids).not.toContain(propio.id);

      // Todos los retornados son SOCIO_LM
      for (const c of body.clientes) {
        expect(c.tipo).toBe(TipoCliente.SOCIO_LM);
      }
    });
  });

  // ── F1 — GET ?rol= filtra por esCliente/esProveedor ──────────────────────────

  describe("GET /api/clientes?rol= — F1 (fase 1 del plan una sola Empresa)", () => {
    it("rol=cliente retorna solo esCliente=true; rol=proveedor solo esProveedor=true; sin rol trae todas; rol inválido → 400", async (ctx) => {
      ensureDb(ctx);

      // Empresa solo cliente, empresa solo proveedor (caso ALMACARGA/EXPRESS
      // LOGISTICA) y empresa cliente y proveedor a la vez (caso Coldex).
      const [soloCliente, soloProveedor, ambos] = await Promise.all([
        prisma.cliente.create({
          data: {
            nombre: "Solo Cliente Vitest",
            nit: nit("rol-solo-cliente"),
            esCliente: true,
            esProveedor: false,
          },
        }),
        prisma.cliente.create({
          data: {
            nombre: "Solo Proveedor Vitest",
            nit: nit("rol-solo-proveedor"),
            esCliente: false,
            esProveedor: true,
          },
        }),
        prisma.cliente.create({
          data: {
            nombre: "Cliente y Proveedor Vitest",
            nit: nit("rol-ambos"),
            esCliente: true,
            esProveedor: true,
          },
        }),
      ]);
      createdClienteIds.push(soloCliente.id, soloProveedor.id, ambos.id);

      // rol=cliente
      const resCliente = await clientesGET(makeRequest("/api/clientes?rol=cliente"));
      expect(resCliente.status).toBe(200);
      const bodyCliente = (await resCliente.json()) as { clientes: { id: string }[] };
      const idsCliente = bodyCliente.clientes.map((c) => c.id);
      expect(idsCliente).toContain(soloCliente.id);
      expect(idsCliente).toContain(ambos.id);
      expect(idsCliente).not.toContain(soloProveedor.id);

      // rol=proveedor
      const resProveedor = await clientesGET(makeRequest("/api/clientes?rol=proveedor"));
      expect(resProveedor.status).toBe(200);
      const bodyProveedor = (await resProveedor.json()) as { clientes: { id: string }[] };
      const idsProveedor = bodyProveedor.clientes.map((c) => c.id);
      expect(idsProveedor).toContain(soloProveedor.id);
      expect(idsProveedor).toContain(ambos.id);
      expect(idsProveedor).not.toContain(soloCliente.id);

      // Sin `rol` — comportamiento histórico: lista todas (la pantalla Empresas
      // filtra en el cliente).
      const resTodas = await clientesGET(makeRequest("/api/clientes"));
      expect(resTodas.status).toBe(200);
      const bodyTodas = (await resTodas.json()) as { clientes: { id: string }[] };
      const idsTodas = bodyTodas.clientes.map((c) => c.id);
      expect(idsTodas).toContain(soloCliente.id);
      expect(idsTodas).toContain(soloProveedor.id);
      expect(idsTodas).toContain(ambos.id);

      // rol inválido → 400 con mensaje en español
      const resInvalido = await clientesGET(makeRequest("/api/clientes?rol=fabricante"));
      expect(resInvalido.status).toBe(400);
      const bodyInvalido = (await resInvalido.json()) as { error: string };
      expect(bodyInvalido.error).toBe("Payload invalido");
    });
  });

  // ── POST con NIT duplicado → 409 ─────────────────────────────────────────────

  describe("POST — NIT duplicado → 409", () => {
    it("segundo POST con el mismo NIT devuelve 409", async (ctx) => {
      ensureDb(ctx);

      const nitValue = nit("dup-nit");
      const payload = { nombre: "Cliente Dup 1", nit: nitValue };

      // Primer POST — debe ser 201
      const res1 = await postCliente(payload);
      expect(res1.status).toBe(201);
      const body1 = await res1.json() as { cliente: { id: string } };
      createdClienteIds.push(body1.cliente.id);

      // Segundo POST con el mismo NIT — debe ser 409
      const res2 = await postCliente({ nombre: "Cliente Dup 2", nit: nitValue });
      expect(res2.status).toBe(409);
      const body2 = await res2.json() as { error: string };
      expect(body2.error).toMatch(/ya existe/i);
    });
  });

  // ── ciudad — round-trip POST/PATCH/GET ───────────────────────────────────────

  describe("ciudad — persiste en POST/PATCH y se refleja en GET", () => {
    it("POST con ciudad la persiste, PATCH la actualiza y la vacía, y un PATCH sin ciudad no la borra", async (ctx) => {
      ensureDb(ctx);

      // POST con ciudad
      const postRes = await postCliente({
        nombre: "Cliente Test Ciudad",
        nit: nit("ciudad-roundtrip"),
        ciudad: "Barranquilla",
      });
      expect(postRes.status).toBe(201);
      const postBody = (await postRes.json()) as { cliente: { id: string; ciudad: string | null } };
      expect(postBody.cliente.ciudad).toBe("Barranquilla");

      const clienteId = postBody.cliente.id;
      createdClienteIds.push(clienteId);

      // GET /[id] la refleja
      const getRes1 = await clienteByIdGET(makeRequest(`/api/clientes/${clienteId}`), routeCtx(clienteId));
      const getBody1 = (await getRes1.json()) as { cliente: { ciudad: string | null } };
      expect(getBody1.cliente.ciudad).toBe("Barranquilla");

      // PATCH cambia la ciudad
      const patchRes1 = await patchCliente(clienteId, { ciudad: "Bogotá" });
      expect(patchRes1.status).toBe(200);
      const patchBody1 = (await patchRes1.json()) as { cliente: { ciudad: string | null } };
      expect(patchBody1.cliente.ciudad).toBe("Bogotá");

      // PATCH sin mencionar `ciudad` (solo nombre) no la toca
      const patchRes2 = await patchCliente(clienteId, { nombre: "Cliente Test Ciudad (renombrado)" });
      expect(patchRes2.status).toBe(200);
      const patchBody2 = (await patchRes2.json()) as { cliente: { ciudad: string | null; nombre: string } };
      expect(patchBody2.cliente.nombre).toBe("Cliente Test Ciudad (renombrado)");
      expect(patchBody2.cliente.ciudad).toBe("Bogotá");

      // PATCH con ciudad "" la deja en null
      const patchRes3 = await patchCliente(clienteId, { ciudad: "" });
      expect(patchRes3.status).toBe(200);
      const patchBody3 = (await patchRes3.json()) as { cliente: { ciudad: string | null } };
      expect(patchBody3.cliente.ciudad).toBeNull();

      // GET /[id] final confirma el null
      const getRes2 = await clienteByIdGET(makeRequest(`/api/clientes/${clienteId}`), routeCtx(clienteId));
      const getBody2 = (await getRes2.json()) as { cliente: { ciudad: string | null } };
      expect(getBody2.cliente.ciudad).toBeNull();
    });
  });

  // ── F1 — PATCH parcial no reinicia los defaults ─────────────────────────────

  type ClienteFlags = {
    tipo: string;
    activo: boolean;
    esCliente: boolean;
    esProveedor: boolean;
    manejaAnticipo: boolean;
    ciudad: string | null;
    contactoNombre: string | null;
    contactoEmail: string | null;
    contactoTel: string | null;
  };

  describe("F1 — PATCH parcial (pop-up de Contacto) no resetea tipo/activo/esCliente/esProveedor/manejaAnticipo/ciudad", () => {
    it("un PATCH que solo trae contactoNombre/contactoEmail/contactoTel deja intactas las demás banderas de una empresa SOCIO_LM inactiva y solo-proveedor", async (ctx) => {
      ensureDb(ctx);

      // Empresa deliberadamente "no default": SOCIO_LM, inactiva, solo
      // proveedor (esCliente=false, esProveedor=true) y sin manejo de
      // anticipo — lo opuesto de los defaults de clientePayloadSchema.
      const postRes = await postCliente({
        nombre: "Cliente F1 Partial Patch",
        nit: nit("f1-partial-patch"),
        tipo: TipoCliente.SOCIO_LM,
        activo: false,
        esCliente: false,
        esProveedor: true,
        manejaAnticipo: false,
        ciudad: "Cartagena",
      });
      expect(postRes.status).toBe(201);
      const postBody = (await postRes.json()) as { cliente: ClienteFlags & { id: string } };
      const clienteId = postBody.cliente.id;
      createdClienteIds.push(clienteId);

      // Confirma que el POST respetó los valores explícitos (no los defaults)
      expect(postBody.cliente.tipo).toBe(TipoCliente.SOCIO_LM);
      expect(postBody.cliente.activo).toBe(false);
      expect(postBody.cliente.esCliente).toBe(false);
      expect(postBody.cliente.esProveedor).toBe(true);
      expect(postBody.cliente.manejaAnticipo).toBe(false);
      expect(postBody.cliente.ciudad).toBe("Cartagena");

      // PATCH solo-contacto, como manda `contacto-editor.tsx`
      const patchRes = await patchCliente(clienteId, {
        contactoNombre: "Nuevo Contacto",
        contactoEmail: "contacto@ejemplo.com",
        contactoTel: "3001234567",
      });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as { cliente: ClienteFlags };

      // Los tres campos de contacto sí se actualizaron
      expect(patchBody.cliente.contactoNombre).toBe("Nuevo Contacto");
      expect(patchBody.cliente.contactoEmail).toBe("contacto@ejemplo.com");
      expect(patchBody.cliente.contactoTel).toBe("3001234567");

      // El resto queda exactamente igual — sin resetear a los defaults
      expect(patchBody.cliente.tipo).toBe(TipoCliente.SOCIO_LM);
      expect(patchBody.cliente.activo).toBe(false);
      expect(patchBody.cliente.esCliente).toBe(false);
      expect(patchBody.cliente.esProveedor).toBe(true);
      expect(patchBody.cliente.manejaAnticipo).toBe(false);
      expect(patchBody.cliente.ciudad).toBe("Cartagena");

      // GET /[id] confirma que quedó persistido así en BD, no solo en la respuesta
      const getRes = await clienteByIdGET(makeRequest(`/api/clientes/${clienteId}`), routeCtx(clienteId));
      const getBody = (await getRes.json()) as { cliente: ClienteFlags };
      expect(getBody.cliente.tipo).toBe(TipoCliente.SOCIO_LM);
      expect(getBody.cliente.activo).toBe(false);
      expect(getBody.cliente.esCliente).toBe(false);
      expect(getBody.cliente.esProveedor).toBe(true);
      expect(getBody.cliente.manejaAnticipo).toBe(false);
      expect(getBody.cliente.ciudad).toBe("Cartagena");
    });

    it("POST sin banderas explícitas sigue aplicando los defaults de negocio", async (ctx) => {
      ensureDb(ctx);

      const postRes = await postCliente({
        nombre: "Cliente F1 Defaults",
        nit: nit("f1-post-defaults"),
      });
      expect(postRes.status).toBe(201);
      const postBody = (await postRes.json()) as { cliente: ClienteFlags & { id: string } };
      createdClienteIds.push(postBody.cliente.id);

      expect(postBody.cliente.tipo).toBe(TipoCliente.PROPIO);
      expect(postBody.cliente.activo).toBe(true);
      expect(postBody.cliente.esCliente).toBe(true);
      expect(postBody.cliente.esProveedor).toBe(false);
      expect(postBody.cliente.manejaAnticipo).toBe(true);
    });
  });
});
