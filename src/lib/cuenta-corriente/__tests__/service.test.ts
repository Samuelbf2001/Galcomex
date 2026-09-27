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
  CuentaCorrienteNoHabilitadaError,
  eliminarMovimientoCuenta,
  FacturaProveedorDuplicadaError,
  getCuentaCorriente,
  MovimientoCuentaEsCruceError,
  MovimientoCuentaNoEncontradoError,
  normalizarNumeroFactura,
  registrarCompensacion,
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

/**
 * Empresa que NUNCA es proveedora y no tiene `cuenta_corriente` encendida:
 * solo `cargos_manuales_contraparte`, para probar que "Registrar factura" ya
 * no depende de esProveedor ni de la cuenta cruzada completa.
 */
async function crearEmpresaSoloCargosManuales(nit: string) {
  const cliente = await prisma.cliente.create({
    data: {
      nombre: `${RUN_ID} ${nit}`,
      nit,
      tipo: "PROPIO",
      esCliente: true,
      esProveedor: false,
    },
  });
  clienteIds.push(cliente.id);

  await setCapacidadesEmpresa({
    empresaId: cliente.id,
    cambios: [{ codigo: "cargos_manuales_contraparte", habilitado: true }],
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

  it("el mensaje de duplicado muestra el N° guardado la primera vez, no el que se tecleó de nuevo", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-mensaje-duplicado`);

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
      numeroFactura: "FE-0002",
    });

    // Segundo intento con formato distinto ("fe.0002"): el error debe citar
    // el número guardado ("FE-0002"), no lo que se tecleó ahora.
    await expect(
      registrarMovimientoCuenta({
        empresaId: empresa.id,
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: "Servicios aduaneros agosto (de nuevo)",
        valor: 4_000_000n,
        fecha: new Date("2026-09-01"),
        usuarioId: USUARIO_ID,
        numeroFactura: "fe.0002",
      }),
    ).rejects.toThrow(/factura FE-0002/);
  });

  it("el mensaje de duplicado trae la fecha de la factura y la fecha en que se registró", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-mensaje-fechas`);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 2_000_000n,
      // Mediodía UTC = mañana en Bogotá (UTC-5): evita que el día calendario
      // se corra al formatear con timeZone America/Bogota.
      fecha: new Date("2026-09-17T15:00:00.000Z"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-3333",
    });

    // La fecha de la factura (17/09/2026) es la que se pasó arriba; la fecha
    // de registro (createdAt) es "ahora": se exige que sea la de hoy en
    // Bogotá y, sobre todo, que sea DISTINTA de la de la factura — así una
    // regresión que use `duplicado.fecha` dos veces (en vez de `createdAt`)
    // hace fallar la prueba en vez de colarse (el regex viejo aceptaba
    // cualquier fecha en ese lugar).
    const hoyBogotaCorto = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date());
    expect(hoyBogotaCorto).not.toBe("17/09/2026");

    await expect(
      registrarMovimientoCuenta({
        empresaId: empresa.id,
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: "Servicios aduaneros (de nuevo)",
        valor: 2_000_000n,
        fecha: new Date("2026-09-20"),
        usuarioId: USUARIO_ID,
        numeroFactura: "fe-3333",
      }),
    ).rejects.toThrow(
      new RegExp(
        `La factura FE-3333 de .+ ya está registrada \\(fecha de la factura 17/09/2026, registrada el ${hoyBogotaCorto}\\)\\.$`,
      ),
    );
  });
});

describe("eliminarMovimientoCuenta", () => {
  it("elimina un movimiento manual: ya no aparece en la cuenta y queda el AuditLog", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-eliminar-ok`);

    const movimiento = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros octubre",
      valor: 1_000_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-8888",
      soporte: { key: "empresas/x/cuenta/factura.pdf", nombre: "factura.pdf", mime: "application/pdf" },
    });

    const eliminado = await eliminarMovimientoCuenta(empresa.id, movimiento.id, USUARIO_ID);
    expect(eliminado.id).toBe(movimiento.id);

    const cuenta = await getCuentaCorriente(empresa.id);
    expect(cuenta.movimientos.find((m) => m.numeroFactura === "FE-8888")).toBeUndefined();

    const auditoria = await prisma.auditLog.findFirst({
      where: { entidad: "MovimientoCuenta", entidadId: movimiento.id, accion: "DELETE_MOVIMIENTO_CUENTA" },
    });
    expect(auditoria).not.toBeNull();
    expect(auditoria?.usuarioId).toBe(USUARIO_ID);
    // El PDF de soporte no se borra de la bodega: el snapshot "antes" es la
    // única constancia (el archivo en R2/MinIO se queda huérfano a propósito).
    expect((auditoria?.antes as Record<string, unknown> | null)?.soporteKey).toBe(
      "empresas/x/cuenta/factura.pdf",
    );

    const enBd = await prisma.movimientoCuenta.findUnique({ where: { id: movimiento.id } });
    expect(enBd).toBeNull();
  });

  it("404 si el movimiento no pertenece a la empresa de la URL", async (ctx) => {
    ensureDb(ctx);
    const empresaA = await crearEmpresaConCargosManuales(`${RUN_ID}-otra-empresa-a`);
    const empresaB = await crearEmpresaConCargosManuales(`${RUN_ID}-otra-empresa-b`);

    const movimiento = await registrarMovimientoCuenta({
      empresaId: empresaA.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 500_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-1111-A",
    });

    await expect(
      eliminarMovimientoCuenta(empresaB.id, movimiento.id, USUARIO_ID),
    ).rejects.toBeInstanceOf(MovimientoCuentaNoEncontradoError);

    // Sigue existiendo: el intento con la empresa equivocada no lo tocó.
    const enBd = await prisma.movimientoCuenta.findUnique({ where: { id: movimiento.id } });
    expect(enBd).not.toBeNull();
  });

  it("409 si el movimiento es de origen COMPENSACION (es parte de un cruce)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-cruce-origen`);

    const movimiento = await prisma.movimientoCuenta.create({
      data: {
        empresaId: empresa.id,
        rol: "CLIENTE",
        tipo: "ABONO",
        origen: "COMPENSACION",
        lineaServicio: "TRAMITE",
        concepto: "Cruce · prueba",
        valor: 300_000n,
        fecha: new Date("2026-09-24"),
        registradoPorId: USUARIO_ID,
        compensacionId: "comp-test-origen",
      },
    });

    await expect(
      eliminarMovimientoCuenta(empresa.id, movimiento.id, USUARIO_ID),
    ).rejects.toBeInstanceOf(MovimientoCuentaEsCruceError);
  });

  it("409 si el movimiento quedó marcado con un cruce aunque su origen no sea COMPENSACION", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-cruce-flag`);

    const movimiento = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 700_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-2222",
    });
    // Estado defensivo que no debería darse por la app (siempre pone COMPENSACION
    // junto con compensacionId), pero el servicio se protege igual.
    await prisma.movimientoCuenta.update({
      where: { id: movimiento.id },
      data: { compensacionId: "comp-test-flag" },
    });

    await expect(
      eliminarMovimientoCuenta(empresa.id, movimiento.id, USUARIO_ID),
    ).rejects.toBeInstanceOf(MovimientoCuentaEsCruceError);
  });

  it("409 si la factura ya se cruzó: el cruce no marca el movimiento manual, pero borrarlo dejaría el saldo del proveedor en negativo", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-cruce-huerfano`);

    // Lado cliente: la empresa nos debe 1.000.000 (para poder cruzar).
    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "CLIENTE",
      tipo: "CARGO",
      origen: "AJUSTE",
      lineaServicio: "TRAMITE",
      concepto: "Ajuste de prueba",
      valor: 1_000_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
    });

    // Lado proveedor: "Registrar factura" por el mismo importe.
    const factura = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 1_000_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-CRUCE-1",
    });

    // "Cruzar saldos" sin factura de venta ni de proveedor concretas: crea sus
    // propias puntas COMPENSACION y NO toca `factura` (compensacionId sigue
    // en null en la factura manual — así lo reprodujo la revisión).
    await registrarCompensacion({
      empresaId: empresa.id,
      valor: 1_000_000n,
      fecha: new Date("2026-09-24"),
      concepto: "Cruce de prueba",
      usuarioId: USUARIO_ID,
    });

    const cuentaCruzada = await getCuentaCorriente(empresa.id);
    expect(cuentaCruzada.pendienteCliente).toBe(0n);
    expect(cuentaCruzada.pendienteProveedor).toBe(0n);

    // Antes del arreglo esto respondía 200 y dejaba pendienteProveedor en
    // -1.000.000 (el cruce quedó descontando una deuda que ya no existe).
    await expect(
      eliminarMovimientoCuenta(empresa.id, factura.id, USUARIO_ID),
    ).rejects.toBeInstanceOf(MovimientoCuentaEsCruceError);
    await expect(
      eliminarMovimientoCuenta(empresa.id, factura.id, USUARIO_ID),
    ).rejects.toThrow(/deshaz el cruce primero/);

    // Sigue existiendo y los saldos no cambiaron.
    const enBd = await prisma.movimientoCuenta.findUnique({ where: { id: factura.id } });
    expect(enBd).not.toBeNull();
    const cuentaFinal = await getCuentaCorriente(empresa.id);
    expect(cuentaFinal.pendienteCliente).toBe(0n);
    expect(cuentaFinal.pendienteProveedor).toBe(0n);
  });

  it("NO bloquea borrar una factura de proveedor aunque la punta CLIENTE ya sea negativa (saldo a favor del cliente), si no hay ningún cruce", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-favor-cliente`);

    // Saldo a favor del cliente (p. ej. sobró anticipo sin devolver, o una nota
    // crédito registrada como ajuste): pendienteCliente queda en -3.000.000
    // ANTES de que exista la factura de proveedor. Antes del arreglo, esto por
    // sí solo bastaba para que CUALQUIER borrado del lado proveedor respondiera
    // 409 "Es parte de un cruce", sin que hubiera ningún cruce.
    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "CLIENTE",
      tipo: "ABONO",
      origen: "AJUSTE",
      lineaServicio: "TRAMITE",
      concepto: "Saldo a favor del cliente (nota crédito)",
      valor: 3_000_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
    });

    const cuentaAntes = await getCuentaCorriente(empresa.id);
    expect(cuentaAntes.pendienteCliente).toBe(-3_000_000n);

    const factura = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 1_000_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-FAVOR-1",
    });

    // Se puede eliminar: no hay ningún cruce, solo un saldo a favor legítimo
    // en la otra punta.
    await expect(
      eliminarMovimientoCuenta(empresa.id, factura.id, USUARIO_ID),
    ).resolves.toBeDefined();

    const cuentaDespues = await getCuentaCorriente(empresa.id);
    expect(cuentaDespues.pendienteProveedor).toBe(0n);
    // El saldo a favor del cliente, sin relación con la factura borrada, sigue igual.
    expect(cuentaDespues.pendienteCliente).toBe(-3_000_000n);
  });

  it("NO bloquea borrar un ajuste PROVEEDOR CARGO aunque deje lo registrado a mano en negativo, si no hay ningún cruce", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-cargo-proveedor-negativo`);

    // Dos ajustes "a cargo" del proveedor (p. ej. un descuento): la parte
    // manual del lado proveedor queda en -350.000. Borrar uno de ellos SUBE lo
    // que le debemos (nunca puede ser la causa de que algo quede negativo).
    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "CARGO",
      origen: "AJUSTE",
      lineaServicio: "TRAMITE",
      concepto: "Descuento del proveedor 1",
      valor: 300_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
    });
    const ajuste2 = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "CARGO",
      origen: "AJUSTE",
      lineaServicio: "TRAMITE",
      concepto: "Descuento del proveedor 2",
      valor: 50_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
    });

    await expect(
      eliminarMovimientoCuenta(empresa.id, ajuste2.id, USUARIO_ID),
    ).resolves.toBeDefined();
  });

  it("dos borrados simultáneos del mismo movimiento: uno gana y el otro recibe 404 (no un error genérico)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaConCargosManuales(`${RUN_ID}-carrera-borrado`);

    const movimiento = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 250_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-7777",
    });

    const resultados = await Promise.allSettled([
      eliminarMovimientoCuenta(empresa.id, movimiento.id, USUARIO_ID),
      eliminarMovimientoCuenta(empresa.id, movimiento.id, USUARIO_ID),
    ]);

    const cumplidas = resultados.filter((r) => r.status === "fulfilled");
    const rechazadas = resultados.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(cumplidas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);
    expect(rechazadas[0]?.reason).toBeInstanceOf(MovimientoCuentaNoEncontradoError);

    const enBd = await prisma.movimientoCuenta.findUnique({ where: { id: movimiento.id } });
    expect(enBd).toBeNull();
  });
});

describe("getCuentaCorriente — visible con solo cargos manuales", () => {
  it("habilitada=true aunque cuenta_corriente esté apagada, si cargos_manuales_contraparte está encendida", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaSoloCargosManuales(`${RUN_ID}-visible-solo-cargos`);

    const cuenta = await getCuentaCorriente(empresa.id);

    expect(cuenta.habilitada).toBe(true);
    expect(cuenta.permiteCargosManuales).toBe(true);
  });
});

describe("registrarMovimientoCuenta — sin esProveedor y sin cuenta_corriente", () => {
  it('"Registrar factura" (CARGO_MANUAL + PROVEEDOR) funciona con solo la capacidad encendida, aunque la empresa no sea proveedora', async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaSoloCargosManuales(`${RUN_ID}-no-proveedor`);
    expect(empresa.esProveedor).toBe(false);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Mensualidad",
      valor: 2_000_000n,
      fecha: new Date("2026-09-24"),
      usuarioId: USUARIO_ID,
      numeroFactura: "FE-7777",
    });

    const cuenta = await getCuentaCorriente(empresa.id);
    expect(cuenta.pendienteProveedor).toBe(2_000_000n);
  });

  it('"Otro ajuste" (AJUSTE) sigue exigiendo cuenta_corriente: se rechaza con solo cargos manuales', async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresaSoloCargosManuales(`${RUN_ID}-otro-ajuste-bloqueado`);

    await expect(
      registrarMovimientoCuenta({
        empresaId: empresa.id,
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "AJUSTE",
        lineaServicio: "TRAMITE",
        concepto: "Ajuste manual",
        valor: 500_000n,
        fecha: new Date("2026-09-24"),
        usuarioId: USUARIO_ID,
      }),
    ).rejects.toBeInstanceOf(CuentaCorrienteNoHabilitadaError);
  });
});
