// @vitest-environment node
/**
 * Integración contra Postgres: el reclamo del envío a SIIGO es atómico de
 * verdad (UPDATE condicional), no solo en el fake en memoria.
 *
 * Siigo está mockeado (no sale nada a la red). Requiere DATABASE_URL (:5433);
 * si la BD no está disponible, los tests se omiten.
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoBorrador, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/borradores/lineas-fijas", () => ({ ensureLineasFijas: vi.fn(async () => {}) }));
vi.mock("@/lib/borradores/recalculo", () => ({ recalcularTotalBorrador: vi.fn(async () => {}) }));

const siigo = vi.hoisted(() => ({
  getToken: vi.fn(async () => "token-prueba"),
  postFactura: vi.fn(),
}));

vi.mock("@/lib/siigo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siigo/client")>()),
  getToken: siigo.getToken,
  postFactura: siigo.postFactura,
}));

import { prisma } from "@/lib/db/prisma";

import { enviarBorradorASiigo } from "../envio-factura-service";
import { EnvioSiigoBloqueadoError } from "../errores-envio";
import { liberarEnvioSiigo } from "../resolver-envio-service";

const TEST_PREFIX = "vitest-siigo-envio";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 3025;
const FORMA_PAGO_ID = 990_000 + Math.floor(Math.random() * 9_000);

type Fixture = { usuarioId: string; tramiteId: string; parametrosCreados: string[] };
let fixture: Fixture | null = null;
let motivo = "DATABASE_URL no está definida; se omite la integración del envío a SIIGO";

function requiereDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(motivo);
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

async function crearBorrador(db: Fixture): Promise<string> {
  const b = await prisma.borradorFactura.create({
    data: {
      tramiteId: db.tramiteId,
      comision: 0n,
      ivaComision: 0n,
      impuesto4x1000: 0n,
      costosBancarios: 0n,
      totalAnticipo: 0n,
      totalPagos: 0n,
      totalFactura: 1_000_000n,
      saldoACargoCliente: 1_000_000n,
      estado: EstadoBorrador.APROBADO,
      formaPagoSiigoId: FORMA_PAGO_ID,
    },
  });
  return b.id;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    motivo = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  const usuario = await prisma.user.create({
    data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest Siigo", rol: Rol.ADMIN },
  });
  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente Vitest Siigo", nit: `${TEST_PREFIX}-${runId}`, tipo: TipoCliente.PROPIO },
  });
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN25-9001-${runId}`,
      ciudad: Ciudad.BUN,
      anio: ANIO,
      numero: 9001 + Math.floor(Math.random() * 1_000_000),
      clienteId: cliente.id,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: usuario.id,
      comentarios: `${TEST_PREFIX}:${runId}`,
    },
  });
  await prisma.siigoFormaPago.create({ data: { id: FORMA_PAGO_ID, nombre: `${TEST_PREFIX} contado` } });

  // Los parámetros Siigo solo se crean si faltan (y solo esos se borran al final).
  const parametrosCreados: string[] = [];
  for (const [clave, valor] of [
    ["SIIGO_TIPO_COMPROBANTE_ID", "101"],
    ["SIIGO_VENDEDOR_ID", "202"],
  ] as const) {
    const existe = await prisma.parametro.findUnique({ where: { clave } });
    if (!existe) {
      await prisma.parametro.create({ data: { clave, valor, descripcion: TEST_PREFIX } });
      parametrosCreados.push(clave);
    }
  }

  fixture = { usuarioId: usuario.id, tramiteId: tramite.id, parametrosCreados };
});

afterAll(async () => {
  if (!fixture) return;
  const { usuarioId, tramiteId, parametrosCreados } = fixture;
  await prisma.auditLog.deleteMany({ where: { usuarioId } });
  await prisma.borradorFactura.deleteMany({ where: { tramiteId } });
  const tramite = await prisma.tramiteDO.delete({ where: { id: tramiteId } });
  await prisma.cliente.delete({ where: { id: tramite.clienteId } });
  await prisma.siigoFormaPago.delete({ where: { id: FORMA_PAGO_ID } });
  await prisma.parametro.deleteMany({ where: { clave: { in: parametrosCreados } } });
  await prisma.user.delete({ where: { id: usuarioId } });
});

beforeEach(() => {
  siigo.getToken.mockClear();
  siigo.postFactura.mockReset();
});

describe("envío a SIIGO contra Postgres", () => {
  it("dos envíos simultáneos del mismo borrador: un solo POST, el otro 409", async (ctx) => {
    const db = requiereDb(ctx);
    const borradorId = await crearBorrador(db);
    siigo.postFactura.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: `sg-${borradorId}`, name: "FV-2-1", date: "2026-09-25" };
    });

    const resultados = await Promise.allSettled([
      enviarBorradorASiigo(borradorId, db.usuarioId),
      enviarBorradorASiigo(borradorId, db.usuarioId),
    ]);

    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rechazo = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rechazo.reason).toBeInstanceOf(EnvioSiigoBloqueadoError);

    const fila = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: borradorId } });
    expect(fila.siigoEnvioEstado).toBe("ENVIADO");
    expect(fila.siigoDraftId).toBe(`sg-${borradorId}`);
    const auditorias = await prisma.auditLog.findMany({ where: { entidadId: borradorId } });
    expect(auditorias.map((a) => a.accion)).toEqual(["SIIGO_ENVIAR_OK"]);
  });

  it("diez envíos simultáneos: un solo POST", async (ctx) => {
    const db = requiereDb(ctx);
    const borradorId = await crearBorrador(db);
    siigo.postFactura.mockImplementation(async () => ({ id: `sg-${borradorId}`, name: "FV-2-2", date: "2026-09-25" }));

    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, () => enviarBorradorASiigo(borradorId, db.usuarioId)),
    );

    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("timeout → INCIERTO bloquea; liberar → ERROR permite un segundo y último POST", async (ctx) => {
    const db = requiereDb(ctx);
    const borradorId = await crearBorrador(db);
    siigo.postFactura.mockRejectedValueOnce(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );

    await expect(enviarBorradorASiigo(borradorId, db.usuarioId)).resolves.toMatchObject({
      tipo: "incierto",
    });
    await expect(enviarBorradorASiigo(borradorId, db.usuarioId)).rejects.toBeInstanceOf(
      EnvioSiigoBloqueadoError,
    );

    await liberarEnvioSiigo(borradorId, db.usuarioId);
    siigo.postFactura.mockResolvedValueOnce({ id: `sg2-${borradorId}`, name: "FV-2-3", date: "2026-09-25" });
    await expect(enviarBorradorASiigo(borradorId, db.usuarioId)).resolves.toMatchObject({ ok: true });

    expect(siigo.postFactura).toHaveBeenCalledTimes(2);
    const acciones = (
      await prisma.auditLog.findMany({ where: { entidadId: borradorId }, orderBy: { createdAt: "asc" } })
    ).map((a) => a.accion);
    expect(acciones).toEqual(["SIIGO_ENVIAR_INCIERTO", "SIIGO_ENVIO_LIBERADO", "SIIGO_ENVIAR_OK"]);
  });
});
