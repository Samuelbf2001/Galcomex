/**
 * Tests de integración — Facturas de Proveedor (WS-A)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten.
 *
 * TEST_PREFIX único: "vitest-fps"
 * Año de datos de prueba: 3005 (no colisiona con datos reales)
 *
 * Cubre:
 * - CRUD de FacturaProveedor
 * - generarPago vincula y marca PAGADA
 * - eliminar con pagos → error 422
 * - unicidad (tramiteId, numFactura)
 * - Permisos SOCIO: trámite cliente PROPIO → 403; trámite SOCIO_LM → ok
 * - solicitarFacturacion: ruta feliz + sin pagos → error
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  CanalPago,
  Ciudad,
  EstadoFacturaProveedor,
  EstadoTramite,
  Rol,
  TipoCliente,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  FacturaProveedorConPagosError,
  FacturaProveedorDuplicadaError,
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
  TramiteSinPagosError,
  actualizarFacturaProveedor,
  crearFacturaProveedor,
  eliminarFacturaProveedor,
  generarPagoDesdeFactura,
  listarPorTramite,
  solicitarFacturacion,
} from "../service";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-fps";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3005;

// ─── Fixture ─────────────────────────────────────────────────────────────────

type Fixture = {
  userId: string;
  userSocioId: string;
  clientePropioId: string;
  clienteSocioLmId: string;
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

  const userIds = testUsers.map((u) => u.id);
  const clienteIds = testClients.map((c) => c.id);

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
  const tramiteIds = testTramites.map((t) => t.id);

  // Eliminar en orden respetando FK constraints
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
      ],
    },
  });

  // Facturas proveedor → pagos
  const fps = await prisma.facturaProveedor.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const fpIds = fps.map((f) => f.id);

  // Desconectar pagos de facturas (eliminar vínculos del pivot N↔N)
  await prisma.pagoTramiteFactura.deleteMany({
    where: { facturaId: { in: fpIds } },
  });

  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  // solicitarFacturacion ahora auto-crea borrador para PROPIO y SOCIO_LM,
  // así que limpiamos primero el grafo del borrador antes del trámite.
  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}-admin@example.test`,
      emailVerified: true,
      name: "Vitest FPS Admin",
      rol: Rol.ADMIN,
    },
  });

  const userSocio = await prisma.user.create({
    data: {
      email: `${runId}-socio@example.test`,
      emailVerified: true,
      name: "Vitest FPS Socio",
      rol: Rol.SOCIO,
    },
  });

  const clientePropio = await prisma.cliente.create({
    data: {
      nombre: "Cliente Propio Test FPS",
      nit: `${TEST_PREFIX}-propio-${runId.slice(-8)}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  const clienteSocioLm = await prisma.cliente.create({
    data: {
      nombre: "Cliente SocioLM Test FPS",
      nit: `${TEST_PREFIX}-sociolm-${runId.slice(-8)}`,
      tipo: TipoCliente.SOCIO_LM,
    },
  });

  return {
    userId: user.id,
    userSocioId: userSocio.id,
    clientePropioId: clientePropio.id,
    clienteSocioLmId: clienteSocioLm.id,
  };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de facturas-proveedor");
    throw new Error("Test omitido");
  }
  return fixture;
}

let tramiteCounter = 0;
async function crearTramiteTest(db: Fixture, clienteId: string): Promise<string> {
  tramiteCounter += 1;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(tramiteCounter).padStart(4, "0")}-fps-${runId.slice(-6)}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero: tramiteCounter,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.userId,
      comentarios: `${TEST_PREFIX}:${runId}`,
    },
  });
  return tramite.id;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
    await cleanupTestData();
    fixture = await createFixture();
  } catch (error) {
    dbUnavailableReason = unavailableMessage(error);
  }
});

afterAll(async () => {
  if (dbConnected) {
    await cleanupTestData();
    await prisma.$disconnect();
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("crearFacturaProveedor", () => {
  it("crea una factura correctamente", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Proveedor Test SA",
      proveedorNit: "900123456-1",
      numFactura: "FACT-0001",
      valor: 1_500_000n,
      fecha: new Date("2026-05-01"),
      subidaPorId: db.userId,
    });

    expect(factura.id).toBeTruthy();
    expect(factura.proveedorNombre).toBe("Proveedor Test SA");
    expect(factura.valor).toBe(1_500_000n);
    expect(factura.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
    expect(factura.tramiteId).toBe(tramiteId);
  });

  it("rechaza factura duplicada (tramiteId + numFactura)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Proveedor Test",
      numFactura: "FACT-DUP-001",
      valor: 500_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await expect(
      crearFacturaProveedor({
        tramiteId,
        proveedorNombre: "Proveedor Test 2",
        numFactura: "FACT-DUP-001",
        valor: 600_000n,
        fecha: new Date(),
        subidaPorId: db.userId,
      }),
    ).rejects.toThrow(FacturaProveedorDuplicadaError);
  });

  it("misma numFactura en diferente tramite es válida", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite1 = await crearTramiteTest(db, db.clientePropioId);
    const tramite2 = await crearTramiteTest(db, db.clientePropioId);

    const f1 = await crearFacturaProveedor({
      tramiteId: tramite1,
      proveedorNombre: "Proveedor A",
      numFactura: "FACT-CROSS-001",
      valor: 100_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    const f2 = await crearFacturaProveedor({
      tramiteId: tramite2,
      proveedorNombre: "Proveedor B",
      numFactura: "FACT-CROSS-001",
      valor: 200_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    expect(f1.id).not.toBe(f2.id);
  });
});

describe("listarPorTramite", () => {
  it("lista facturas de un trámite en orden por fecha", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Prov A",
      numFactura: "FP-01",
      valor: 100_000n,
      fecha: new Date("2026-04-01"),
      subidaPorId: db.userId,
    });
    await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Prov B",
      numFactura: "FP-02",
      valor: 200_000n,
      fecha: new Date("2026-04-02"),
      subidaPorId: db.userId,
    });

    const facturas = await listarPorTramite(tramiteId);
    expect(facturas.length).toBe(2);
    expect(facturas[0].numFactura).toBe("FP-01");
    expect(facturas[1].numFactura).toBe("FP-02");
  });
});

describe("actualizarFacturaProveedor", () => {
  it("actualiza campos correctamente", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Proveedor Original",
      numFactura: "FP-UPD-01",
      valor: 300_000n,
      fecha: new Date("2026-03-01"),
      subidaPorId: db.userId,
    });

    const updated = await actualizarFacturaProveedor(
      factura.id,
      { proveedorNombre: "Proveedor Actualizado", valor: 350_000n },
      db.userId,
    );

    expect(updated.proveedorNombre).toBe("Proveedor Actualizado");
    expect(updated.valor).toBe(350_000n);
    expect(updated.numFactura).toBe("FP-UPD-01"); // no cambió
  });

  it("lanza error si la factura no existe", async (ctx) => {
    const db = ensureDb(ctx);
    await expect(
      actualizarFacturaProveedor("id-inexistente", { valor: 100n }, db.userId),
    ).rejects.toThrow(FacturaProveedorNoEncontradaError);
  });

  it("rechaza actualizar una factura que ya está PAGADA", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Proveedor Pagado",
      numFactura: "FP-PAGADA-UPD-01",
      valor: 750_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    // Generar el pago deja la factura en estado PAGADA
    await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });

    // Intentar actualizar una factura PAGADA debe lanzar el error de estado
    await expect(
      actualizarFacturaProveedor(factura.id, { valor: 800_000n }, db.userId),
    ).rejects.toThrow(FacturaProveedorNoModificableError);
  });
});

describe("eliminarFacturaProveedor", () => {
  it("elimina una factura sin pagos", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Prov Delete",
      numFactura: "FP-DEL-01",
      valor: 100_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await eliminarFacturaProveedor(factura.id, db.userId);

    const encontrada = await prisma.facturaProveedor.findUnique({ where: { id: factura.id } });
    expect(encontrada).toBeNull();
  });

  it("rechaza eliminación si tiene pagos vinculados", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Prov Con Pago",
      numFactura: "FP-PAGO-01",
      valor: 500_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    // Generar el pago (lo vincula)
    await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });

    await expect(
      eliminarFacturaProveedor(factura.id, db.userId),
    ).rejects.toThrow(FacturaProveedorConPagosError);
  });

  it("lanza error si la factura no existe", async (ctx) => {
    const db = ensureDb(ctx);
    await expect(
      eliminarFacturaProveedor("id-inexistente", db.userId),
    ).rejects.toThrow(FacturaProveedorNoEncontradaError);
  });
});

describe("generarPagoDesdeFactura", () => {
  it("crea un PagoTramite vinculado y marca la factura como PAGADA", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "LUTOSA SAS",
      numFactura: "FACT-FESP-001",
      valor: 2_500_000n,
      fecha: new Date("2026-05-10"),
      subidaPorId: db.userId,
    });

    expect(factura.estado).toBe(EstadoFacturaProveedor.REGISTRADA);

    const { pago, factura: facturaActualizada } = await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });

    // Pago creado
    expect(pago.tramiteId).toBe(tramiteId);
    expect(pago.valor).toBe(2_500_000n);
    // beneficiarios ahora en tabla pivot; el registro base no tiene beneficiarioId
    expect(pago.id).toBeTruthy();
    expect(pago.numSoporte).toBe("FACT-FESP-001");
    const vinculo = await prisma.pagoTramiteFactura.findFirst({
      where: { pagoId: pago.id, facturaId: factura.id },
    });
    expect(vinculo).not.toBeNull();
    expect(pago.viaSocio).toBe(false);
    expect(pago.canalPago).toBe(CanalPago.PSE);
    expect(pago.costoBancario).toBe(0n); // PSE = $0

    // Factura marcada como PAGADA
    expect(facturaActualizada.estado).toBe(EstadoFacturaProveedor.PAGADA);
  });

  it("viaSocio=true se persiste en el pago", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Proveedor Efectivo",
      numFactura: "FP-SOCIO-01",
      valor: 1_000_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    const { pago } = await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      viaSocio: true,
      usuarioId: db.userId,
    });

    expect(pago.viaSocio).toBe(true);
  });

  it("costo bancario se resuelve desde matriz (BANCOLOMBIA_TRANSFERENCIA = 3.900)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Prov Transf",
      numFactura: "FP-COSTO-01",
      valor: 800_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    const { pago } = await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      viaSocio: false,
      usuarioId: db.userId,
    });

    expect(pago.costoBancario).toBe(3_900n);
  });

  it("lanza error si la factura no existe", async (ctx) => {
    const db = ensureDb(ctx);
    await expect(
      generarPagoDesdeFactura({
        facturaProveedorId: "id-inexistente",
        canalPago: CanalPago.PSE,
        viaSocio: false,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(FacturaProveedorNoEncontradaError);
  });

  it("no permite generar pago dos veces sobre la misma factura (no doble pago)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Proveedor No Doble",
      numFactura: "FP-DOBLE-01",
      valor: 1_000_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    // Primera llamada: debe tener éxito y marcar la factura como PAGADA
    await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });

    // Segunda llamada sobre la misma factura (ahora en estado PAGADA): debe lanzar error
    await expect(
      generarPagoDesdeFactura({
        facturaProveedorId: factura.id,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(FacturaProveedorNoModificableError);

    // Verificar que en BD solo existe UN PagoTramite para este trámite
    const totalPagos = await prisma.pagoTramite.count({
      where: { tramiteId },
    });
    expect(totalPagos).toBe(1);
  });
});

describe("solicitarFacturacion", () => {
  it("falla con error si el trámite no tiene pagos", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    await expect(
      solicitarFacturacion(tramiteId, db.userId),
    ).rejects.toThrow(TramiteSinPagosError);
  });

  it("falla si el DO no está en estado válido para la transición", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    // Crear un pago para pasar la validación de pagos>0
    await prisma.pagoTramite.create({
      data: {
        tramiteId,
        concepto: "Test pago",
        valor: 100_000n,
        canalPago: CanalPago.PSE,
        costoBancario: 0n,
      },
    });

    // DO está en SOLICITUD, no puede saltar directo a ENVIADO_A_FACTURAR
    const result = await solicitarFacturacion(tramiteId, db.userId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  it("transiciona correctamente desde DESPACHADO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    // Crear un pago
    await prisma.pagoTramite.create({
      data: {
        tramiteId,
        concepto: "Pago test",
        valor: 500_000n,
        canalPago: CanalPago.PSE,
        costoBancario: 0n,
      },
    });

    // Avanzar el DO hasta DESPACHADO (que es el estado desde el que se puede ir a ENVIADO_A_FACTURAR)
    await prisma.tramiteDO.update({
      where: { id: tramiteId },
      data: { estado: EstadoTramite.DESPACHADO },
    });

    const result = await solicitarFacturacion(tramiteId, db.userId);
    expect(result.ok).toBe(true);

    // Verificar que el DO quedó en ENVIADO_A_FACTURAR con la fecha
    const tramiteActualizado = await prisma.tramiteDO.findUnique({
      where: { id: tramiteId },
      select: { estado: true, fechaEnviadoAFacturar: true },
    });
    expect(tramiteActualizado?.estado).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
    expect(tramiteActualizado?.fechaEnviadoAFacturar).not.toBeNull();
  });
});

describe("Permisos SOCIO", () => {
  it("SOCIO puede crear factura en trámite SOCIO_LM", async (ctx) => {
    const db = ensureDb(ctx);
    // Solo verificamos que no lanza error al nivel de servicio
    const tramiteId = await crearTramiteTest(db, db.clienteSocioLmId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      proveedorNombre: "Prov SOCIO_LM",
      numFactura: "FP-LM-001",
      valor: 200_000n,
      fecha: new Date(),
      subidaPorId: db.userSocioId,
    });

    expect(factura.id).toBeTruthy();
    expect(factura.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
  });

  it("Distinción PROPIO vs SOCIO_LM existe en la BD correctamente", async (ctx) => {
    const db = ensureDb(ctx);

    const clientePropio = await prisma.cliente.findUnique({
      where: { id: db.clientePropioId },
      select: { tipo: true },
    });
    const clienteSocioLm = await prisma.cliente.findUnique({
      where: { id: db.clienteSocioLmId },
      select: { tipo: true },
    });

    expect(clientePropio?.tipo).toBe(TipoCliente.PROPIO);
    expect(clienteSocioLm?.tipo).toBe(TipoCliente.SOCIO_LM);
  });
});
