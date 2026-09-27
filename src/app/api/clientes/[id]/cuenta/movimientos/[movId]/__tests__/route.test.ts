/**
 * DELETE /api/clientes/[id]/cuenta/movimientos/[movId] — eliminar un
 * movimiento manual de la cuenta corriente (M5, ajustes 2026-09-26).
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no
 * está disponible (mismo patrón que el resto de tests de integración).
 */
import "dotenv/config";

import { Rol } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { DELETE as movimientoDELETE } from "@/app/api/clientes/[id]/cuenta/movimientos/[movId]/route";
import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { auth } from "@/lib/auth/auth";
import { registrarMovimientoCuenta } from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";

const TEST_PREFIX = "vitest-cuenta-mov-route";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresaId = "";
let empresaAjenaId = "";
const clienteIds: string[] = [];

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Cuenta Movimiento",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-cuenta-mov",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "token-cuenta-mov",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

function routeCtx(id: string, movId: string) {
  return { params: Promise.resolve({ id, movId }) };
}

function deleteRequest() {
  return new NextRequest("http://localhost/api/clientes/x/cuenta/movimientos/y", {
    method: "DELETE",
  });
}

async function crearMovimiento(empresa: string, numeroFactura: string) {
  return registrarMovimientoCuenta({
    empresaId: empresa,
    rol: "PROVEEDOR",
    tipo: "ABONO",
    origen: "CARGO_MANUAL",
    lineaServicio: "TRAMITE",
    concepto: "Servicios aduaneros",
    valor: 1_000_000n,
    fecha: new Date("2026-09-24"),
    usuarioId,
    numeroFactura,
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de la ruta";
    return;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  const usuario = await prisma.user.create({
    data: {
      email: `${RUN_ID}@example.test`,
      emailVerified: true,
      name: "Vitest Cuenta Movimiento",
      rol: Rol.ADMIN,
    },
  });
  usuarioId = usuario.id;

  const empresa = await prisma.cliente.create({
    data: { nombre: `${RUN_ID} empresa`, nit: `${RUN_ID}-a`, tipo: "PROPIO", esCliente: true, esProveedor: true },
  });
  empresaId = empresa.id;
  clienteIds.push(empresaId);

  const empresaAjena = await prisma.cliente.create({
    data: { nombre: `${RUN_ID} ajena`, nit: `${RUN_ID}-b`, tipo: "PROPIO", esCliente: true, esProveedor: true },
  });
  empresaAjenaId = empresaAjena.id;
  clienteIds.push(empresaAjenaId);

  await setCapacidadesEmpresa({
    empresaId,
    cambios: [
      { codigo: "cuenta_corriente", habilitado: true },
      { codigo: "cargos_manuales_contraparte", habilitado: true },
    ],
    usuarioId,
  });
  await setCapacidadesEmpresa({
    empresaId: empresaAjenaId,
    cambios: [{ codigo: "cargos_manuales_contraparte", habilitado: true }],
    usuarioId,
  });

  vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
});

beforeEach(() => {
  // Cada test parte de ADMIN por defecto; los que prueban otro rol o sin
  // sesión usan `mockResolvedValueOnce` para esa única llamada. Sin este
  // reset, un "Once" que un test deja sin consumir (ninguna ruta lo llamó)
  // se filtra al siguiente test y pisa su propio mock.
  vi.mocked(auth.api.getSession).mockReset();
  vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));
});

afterAll(async () => {
  if (!dbConnected) return;

  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: clienteIds } } });
  const auditIds = await prisma.auditLog.findMany({ where: { usuarioId }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds.map((a) => a.id) } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: usuarioId } });
  await prisma.$disconnect();
});

describe("DELETE /api/clientes/[id]/cuenta/movimientos/[movId]", () => {
  it("ADMIN elimina un movimiento manual y recibe la cuenta actualizada", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));

    const movimiento = await crearMovimiento(empresaId, "FE-RUTA-0001");

    const response = await movimientoDELETE(deleteRequest(), routeCtx(empresaId, movimiento.id));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { cuenta: { movimientos: { numeroFactura: string | null }[] } };
    expect(payload.cuenta.movimientos.some((m) => m.numeroFactura === "FE-RUTA-0001")).toBe(false);
  });

  it("404 si el movimiento no es de la empresa de la URL", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));

    const movimiento = await crearMovimiento(empresaId, "FE-RUTA-0002");

    const response = await movimientoDELETE(deleteRequest(), routeCtx(empresaAjenaId, movimiento.id));
    expect(response.status).toBe(404);
  });

  it("409 si el movimiento es parte de un cruce", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion(Rol.ADMIN));

    const cruce = await prisma.movimientoCuenta.create({
      data: {
        empresaId,
        rol: "CLIENTE",
        tipo: "ABONO",
        origen: "COMPENSACION",
        lineaServicio: "TRAMITE",
        concepto: "Cruce · prueba de ruta",
        valor: 200_000n,
        fecha: new Date("2026-09-24"),
        registradoPorId: usuarioId,
        compensacionId: "comp-ruta-test",
      },
    });

    const response = await movimientoDELETE(deleteRequest(), routeCtx(empresaId, cruce.id));
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Es parte de un cruce: deshaz el cruce primero.");
  });

  async function esperar403ParaRol(rol: Rol, ctx: { skip: (note?: string) => void }) {
    ensureDb(ctx);
    const movimiento = await crearMovimiento(empresaId, `FE-RUTA-ROL-${rol}`);
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(sesion(rol));

    const response = await movimientoDELETE(deleteRequest(), routeCtx(empresaId, movimiento.id));
    expect(response.status).toBe(403);

    // No se vio afectado: sigue existiendo (rechazado antes de llamar al servicio).
    // `findUnique` va directo a Prisma, no pasa por `requireRole`.
    const enBd = await prisma.movimientoCuenta.findUnique({ where: { id: movimiento.id } });
    expect(enBd).not.toBeNull();
  }

  it("403 para el rol REVISOR", async (ctx) => esperar403ParaRol(Rol.REVISOR, ctx));
  it("403 para el rol OPERATIVO", async (ctx) => esperar403ParaRol(Rol.OPERATIVO, ctx));
  it("403 para el rol SOCIO", async (ctx) => esperar403ParaRol(Rol.SOCIO, ctx));

  it("401 sin sesión", async (ctx) => {
    ensureDb(ctx);
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const movimiento = await crearMovimiento(empresaId, "FE-RUTA-0003");
    const response = await movimientoDELETE(deleteRequest(), routeCtx(empresaId, movimiento.id));
    expect(response.status).toBe(401);
  });
});
