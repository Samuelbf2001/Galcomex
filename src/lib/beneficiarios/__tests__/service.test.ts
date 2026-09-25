/**
 * M5 — Enlazar la ficha de pago (beneficiario) con un clic.
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no
 * está disponible. Usa TEST_PREFIX en el NIT/nombre para poder limpiar.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  actualizarBeneficiario,
  crearBeneficiario,
  EmpresaNoEncontradaError,
  EmpresaNoEncontradaParaBeneficiarioError,
  enlazarBeneficiarioEmpresa,
  nitBase,
} from "@/lib/beneficiarios/service";

const TEST_PREFIX = "vitest-beneficiarios";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let USUARIO_ID = "";

let dbConnected = false;
let dbUnavailableReason: string | null = null;

const clienteIds: string[] = [];
const beneficiarioIds: string[] = [];

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

async function crearEmpresa(nit: string, opts: { esProveedor?: boolean } = {}) {
  const cliente = await prisma.cliente.create({
    data: {
      nombre: `${RUN_ID} ${nit}`,
      nit,
      tipo: "PROPIO",
      esCliente: true,
      esProveedor: opts.esProveedor ?? true,
    },
  });
  clienteIds.push(cliente.id);
  return cliente;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten tests de beneficiarios";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
    const usuario = await prisma.user.create({
      data: {
        email: `${RUN_ID}@example.test`,
        emailVerified: true,
        name: "Vitest Beneficiarios",
        rol: "ADMIN",
      },
    });
    USUARIO_ID = usuario.id;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
  }
});

afterAll(async () => {
  if (!dbConnected) return;

  const auditIds = await prisma.auditLog.findMany({
    where: { usuarioId: USUARIO_ID },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds.map((a) => a.id) } } });
  if (beneficiarioIds.length > 0) {
    await prisma.beneficiario.deleteMany({ where: { id: { in: beneficiarioIds } } });
  }
  await prisma.beneficiario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.beneficiario.deleteMany({ where: { nombre: { startsWith: RUN_ID } } });
  if (clienteIds.length > 0) {
    await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  }
  if (USUARIO_ID) {
    await prisma.user.deleteMany({ where: { id: USUARIO_ID } });
  }

  await prisma.$disconnect();
});

describe("nitBase", () => {
  it("quita puntos, espacios y el dígito de verificación", () => {
    expect(nitBase("800.193.576-1")).toBe("800193576");
    expect(nitBase("800193576")).toBe("800193576");
    expect(nitBase(" 800193576-1 ")).toBe("800193576");
  });
});

describe("crearBeneficiario / actualizarBeneficiario — persistencia de empresaId", () => {
  it("guarda empresaId al crear", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(`${RUN_ID}-crear`);

    const beneficiario = await crearBeneficiario(
      { nombre: "Ficha de prueba", nit: empresa.nit, empresaId: empresa.id },
      USUARIO_ID,
    );
    beneficiarioIds.push(beneficiario.id);

    expect(beneficiario.empresaId).toBe(empresa.id);
  });

  it("rechaza empresaId de una empresa inexistente al crear", async (ctx) => {
    ensureDb(ctx);
    await expect(
      crearBeneficiario({ nombre: "Ficha huérfana", empresaId: "no-existe" }, USUARIO_ID),
    ).rejects.toBeInstanceOf(EmpresaNoEncontradaParaBeneficiarioError);
  });

  it("guarda empresaId al actualizar", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(`${RUN_ID}-actualizar`);
    const beneficiario = await crearBeneficiario({ nombre: "Sin enlazar" }, USUARIO_ID);
    beneficiarioIds.push(beneficiario.id);
    expect(beneficiario.empresaId).toBeNull();

    const actualizado = await actualizarBeneficiario(
      beneficiario.id,
      { empresaId: empresa.id },
      USUARIO_ID,
    );

    expect(actualizado.empresaId).toBe(empresa.id);
  });

  it("rechaza empresaId de una empresa inexistente al actualizar", async (ctx) => {
    ensureDb(ctx);
    const beneficiario = await crearBeneficiario({ nombre: "Otra ficha" }, USUARIO_ID);
    beneficiarioIds.push(beneficiario.id);

    await expect(
      actualizarBeneficiario(beneficiario.id, { empresaId: "no-existe" }, USUARIO_ID),
    ).rejects.toBeInstanceOf(EmpresaNoEncontradaParaBeneficiarioError);
  });
});

describe("enlazarBeneficiarioEmpresa", () => {
  it("404 si la empresa no existe", async (ctx) => {
    ensureDb(ctx);
    await expect(enlazarBeneficiarioEmpresa("no-existe", USUARIO_ID)).rejects.toBeInstanceOf(
      EmpresaNoEncontradaError,
    );
  });

  it("es idempotente: si ya hay un beneficiario enlazado, lo devuelve tal cual", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(`${RUN_ID}-ya-enlazado`);
    const yaEnlazado = await crearBeneficiario(
      { nombre: "Ficha ya enlazada", empresaId: empresa.id },
      USUARIO_ID,
    );
    beneficiarioIds.push(yaEnlazado.id);

    const resultado = await enlazarBeneficiarioEmpresa(empresa.id, USUARIO_ID);

    expect(resultado.id).toBe(yaEnlazado.id);
  });

  it("enlaza un beneficiario existente por NIT BASE (sin DV, puntos ni espacios)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(`${RUN_ID}-nitbase-800193580`);
    // El beneficiario trae el NIT con DV y puntos; la empresa lo tiene "limpio".
    const suelto = await crearBeneficiario(
      { nombre: "Beneficiario suelto por NIT", nit: `${nitBase(empresa.nit)}-1` },
      USUARIO_ID,
    );
    beneficiarioIds.push(suelto.id);

    const resultado = await enlazarBeneficiarioEmpresa(empresa.id, USUARIO_ID);

    expect(resultado.id).toBe(suelto.id);
    const recargado = await prisma.beneficiario.findUniqueOrThrow({ where: { id: suelto.id } });
    expect(recargado.empresaId).toBe(empresa.id);
  });

  it("crea un beneficiario nuevo si no hay ninguno con ese NIT base", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(`${RUN_ID}-crea-nuevo`);

    const resultado = await enlazarBeneficiarioEmpresa(empresa.id, USUARIO_ID);
    beneficiarioIds.push(resultado.id);

    expect(resultado.empresaId).toBe(empresa.id);
    expect(resultado.nombre).toBe(empresa.nombre);
    expect(resultado.nit).toBe(empresa.nit);

    const auditoria = await prisma.auditLog.findFirst({
      where: { entidad: "Beneficiario", entidadId: resultado.id, accion: "ENLAZAR_BENEFICIARIO_EMPRESA" },
    });
    expect(auditoria).not.toBeNull();
  });
});
