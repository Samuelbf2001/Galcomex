/**
 * M5 — "Registrar factura de <proveedor>": persistencia de numeroFactura y
 * soporte en MovimientoCuenta, signo correcto en la cuenta y duplicado → 409.
 *
 * Requiere DATABASE_URL con Postgres local; se omite automáticamente si no
 * está disponible.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import {
  FacturaProveedorDuplicadaError,
  getCuentaCorriente,
  normalizarNumeroFactura,
  registrarMovimientoCuenta,
} from "@/lib/cuenta-corriente/service";

const TEST_PREFIX = "vitest-cuenta-factura";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let USUARIO_ID = "";

let dbConnected = false;
let dbUnavailableReason: string | null = null;

const clienteIds: string[] = [];

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD no disponible");
}

async function crearEmpresaConCargosManuales(nit: string) {
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

  await setCapacidadesEmpresa({
    empresaId: cliente.id,
    cambios: [
      { codigo: "cuenta_corriente", habilitado: true },
      { codigo: "cargos_manuales_contraparte", habilitado: true },
    ],
    usuarioId: USUARIO_ID,
  });

  return cliente;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten tests de cuenta corriente";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
    const usuario = await prisma.user.create({
      data: {
        email: `${RUN_ID}@example.test`,
        emailVerified: true,
        name: "Vitest Cuenta Factura",
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

  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: clienteIds } } });
  const auditIds = await prisma.auditLog.findMany({ where: { usuarioId: USUARIO_ID }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds.map((a) => a.id) } } });
  if (clienteIds.length > 0) {
    await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  }
  if (USUARIO_ID) {
    await prisma.user.deleteMany({ where: { id: USUARIO_ID } });
  }

  await prisma.$disconnect();
});

describe("normalizarNumeroFactura", () => {
  it("mayúsculas, sin espacios, puntos ni guiones", () => {
    expect(normalizarNumeroFactura("fe-1234")).toBe("FE1234");
    expect(normalizarNumeroFactura(" FE.1234 ")).toBe("FE1234");
  });
});

describe("registrarMovimientoCuenta — factura de proveedor", () => {
  it("ABONO + PROVEEDOR aumenta lo que le debemos (pendienteProveedor) y guarda numeroFactura", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-signo`);

    const antes = await getCuentaCorriente(empresa.id);
    expect(antes.pendienteProveedor).toBe(0n);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros septiembre",
      valor: 4_500_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-1234",
    });

    const despues = await getCuentaCorriente(empresa.id);
    expect(despues.pendienteProveedor).toBe(4_500_000n);
    expect(despues.neto).toBe(-4_500_000n);

    const movimientoManual = despues.movimientos.find((m) => m.numeroFactura === "FE-1234");
    expect(movimientoManual).toBeDefined();
    expect(movimientoManual?.tieneSoporte).toBe(false);
  });

  it("registra el soporte y lo refleja en tieneSoporte", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-soporte`);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Quincenas septiembre",
      valor: 1_200_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-5678",
      soporte: { key: "empresas/x/cuenta/y.pdf", nombre: "factura.pdf", mime: "application/pdf" },
    });

    const cuenta = await getCuentaCorriente(empresa.id);
    const movimiento = cuenta.movimientos.find((m) => m.numeroFactura === "FE-5678");
    expect(movimiento?.tieneSoporte).toBe(true);
  });

  it("rechaza (409) registrar dos veces la misma factura para la misma empresa+rol", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-duplicado`);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros agosto",
      valor: 4_000_000n,
      fecha: new Date("2026-08-15"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-0001",
    });

    await expect(
      registrarMovimientoCuenta({
        empresaId: empresa.id,
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: "Servicios aduaneros agosto (duplicado)",
        valor: 4_000_000n,
        fecha: new Date("2026-09-01"),
        usuarioId: USUARIO_ID,
        // Mismo número, con formato distinto: debe normalizar igual.
        numeroFactura: "fe.0001",
      }),
    ).rejects.toBeInstanceOf(FacturaProveedorDuplicadaError);
  });

  it("no choca con la punta CLIENTE: el mismo N° de factura en otro rol sí se puede registrar", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-otro-rol`);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Factura proveedor",
      valor: 1_000_000n,
      fecha: new Date("2026-09-01"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-9999",
    });

    await expect(
      registrarMovimientoCuenta({
        empresaId: empresa.id,
        rol: "CLIENTE",
        tipo: "CARGO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: "Factura cliente",
        valor: 1_000_000n,
        fecha: new Date("2026-09-01"),
        usuarioId: USUARIO_ID,
        numeroFactura: "FE-9999",
      }),
    ).resolves.toBeDefined();
  });
});
