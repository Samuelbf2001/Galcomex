/**
 * M5 — «Enlazar ficha de pago» con un clic y `empresaId` en fichas (rama
 * Coldex, portado sobre CxP v2). La búsqueda por NIT usa la llave de proveedor
 * de CxP v2 (`nitBase` = `cxp_nit_base`, sin adivinar el DV).
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no
 * está disponible. NIT ficticios de 9 dígitos por corrida (6xx.xxx.xxx).
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  actualizarBeneficiario,
  crearBeneficiario,
  EmpresaNoEncontradaError,
  EmpresaNoEncontradaParaBeneficiarioError,
  enlazarBeneficiarioEmpresa,
} from "@/lib/beneficiarios/service";
import { dvNit } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";

const TEST_PREFIX = "vitest-beneficiarios-enlazar";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let USUARIO_ID = "";

let dbConnected = false;
let dbUnavailableReason: string | null = null;

const clienteIds: string[] = [];
const beneficiarioIds: string[] = [];

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

/** Base de 9 dígitos por corrida (6xx.xxx.xxx: fuera de los NIT de prueba reales). */
function baseAleatoria(): string {
  return String(600_000_000 + Math.floor(Math.random() * 99_999_999));
}

async function crearEmpresa(nit: string) {
  const cliente = await prisma.cliente.create({
    data: {
      nombre: `${RUN_ID} ${nit}`,
      nit,
      tipo: "PROPIO",
      esCliente: true,
      esProveedor: true,
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
        name: "Vitest Beneficiarios Enlazar",
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

  await prisma.auditLog.deleteMany({ where: { usuarioId: USUARIO_ID } });
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

describe("crearBeneficiario / actualizarBeneficiario — persistencia de empresaId", () => {
  it("guarda empresaId al crear", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(baseAleatoria());

    const beneficiario = await crearBeneficiario(
      { nombre: `${RUN_ID} Ficha de prueba`, nit: empresa.nit, empresaId: empresa.id },
      USUARIO_ID,
    );
    beneficiarioIds.push(beneficiario.id);

    expect(beneficiario.empresaId).toBe(empresa.id);
  });

  it("rechaza empresaId de una empresa inexistente al crear", async (ctx) => {
    ensureDb(ctx);
    await expect(
      crearBeneficiario({ nombre: `${RUN_ID} Ficha huérfana`, empresaId: "no-existe" }, USUARIO_ID),
    ).rejects.toBeInstanceOf(EmpresaNoEncontradaParaBeneficiarioError);
  });

  it("guarda empresaId al actualizar", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(baseAleatoria());
    const beneficiario = await crearBeneficiario({ nombre: `${RUN_ID} Sin enlazar` }, USUARIO_ID);
    beneficiarioIds.push(beneficiario.id);
    expect(beneficiario.empresaId).toBeNull();

    const actualizado = await actualizarBeneficiario(beneficiario.id, { empresaId: empresa.id }, USUARIO_ID);

    expect(actualizado.empresaId).toBe(empresa.id);
  });

  it("rechaza empresaId de una empresa inexistente al actualizar", async (ctx) => {
    ensureDb(ctx);
    const beneficiario = await crearBeneficiario({ nombre: `${RUN_ID} Otra ficha` }, USUARIO_ID);
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

  it("es idempotente: si ya hay una ficha enlazada, la devuelve tal cual y no audita", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(baseAleatoria());
    const yaEnlazado = await crearBeneficiario(
      { nombre: `${RUN_ID} Ficha ya enlazada`, empresaId: empresa.id },
      USUARIO_ID,
    );
    beneficiarioIds.push(yaEnlazado.id);

    const resultado = await enlazarBeneficiarioEmpresa(empresa.id, USUARIO_ID);

    expect(resultado.id).toBe(yaEnlazado.id);
    const auditoria = await prisma.auditLog.findFirst({
      where: { entidadId: yaEnlazado.id, accion: "ENLAZAR_BENEFICIARIO_EMPRESA" },
    });
    expect(auditoria).toBeNull();
  });

  it("enlaza una ficha suelta por NIT BASE: empresa sin DV, ficha con DV y puntos", async (ctx) => {
    ensureDb(ctx);
    const base = baseAleatoria();
    const empresa = await crearEmpresa(base);
    const puntos = `${base.slice(0, 3)}.${base.slice(3, 6)}.${base.slice(6)}`;
    const suelto = await crearBeneficiario(
      { nombre: `${RUN_ID} Ficha suelta por NIT`, nit: `${puntos}-${dvNit(base)}` },
      USUARIO_ID,
    );
    beneficiarioIds.push(suelto.id);
    expect(suelto.nitBase).toBe(base);

    const resultado = await enlazarBeneficiarioEmpresa(empresa.id, USUARIO_ID);

    expect(resultado.id).toBe(suelto.id);
    const recargado = await prisma.beneficiario.findUniqueOrThrow({ where: { id: suelto.id } });
    expect(recargado.empresaId).toBe(empresa.id);
  });

  it("no adivina el DV: la empresa '<base>-DV' no enlaza una ficha cuyo NIT es la base sin su último dígito", async (ctx) => {
    ensureDb(ctx);
    const base = baseAleatoria();
    const empresa = await crearEmpresa(`${base}-${dvNit(base)}`);
    const recortada = base.slice(0, -1);
    const parecida = await crearBeneficiario(
      { nombre: `${RUN_ID} Ficha parecida`, nit: recortada, confirmarOtraFicha: true },
      USUARIO_ID,
    );
    beneficiarioIds.push(parecida.id);

    const resultado = await enlazarBeneficiarioEmpresa(empresa.id, USUARIO_ID);
    beneficiarioIds.push(resultado.id);

    expect(resultado.id).not.toBe(parecida.id);
    expect(resultado.nitBase).toBe(base);
  });

  it("crea una ficha nueva si no hay ninguna con ese NIT base", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa(baseAleatoria());

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
