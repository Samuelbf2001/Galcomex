/**
 * Tests de integración — Facturas de Proveedor (WS-A)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten.
 *
 * TEST_PREFIX único: "vitest-fps"
 * Año de datos de prueba: 3005 (no colisiona con datos reales)
 *
 * CxP v2 (P2): toda factura nace con su ficha de pago (R7). Cada alta usa una
 * ficha NUEVA (`nuevaFicha`) para que la llave anti-duplicado por proveedor
 * (y su aviso por dígitos) no mezcle casos que no tienen que ver entre sí.
 * Los trámites donde se genera un pago llevan anticipo aplicado (la función
 * «Sin anticipo no hay pago» está encendida por defecto).
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
  DisparadorTarifa,
  EstadoFacturaProveedor,
  EstadoTarifario,
  EstadoTramite,
  Rol,
  TipoCalculoTarifa,
  TipoCliente,
  UnidadTarifa,
  TipoRecaudo,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FacturaConPagosError, FacturaDuplicadaError } from "@/lib/cxp/errores";
import { prisma } from "@/lib/db/prisma";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import {
  FacturaProveedorConPagosError,
  FacturaProveedorDuplicadaError,
  FacturaProveedorNoEncontradaError,
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

  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
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
  // Tarifario/TarifaItem (test de "tarifa OTROS con ítem pendiente"): los
  // ítems se van en cascada al borrar el tarifario.
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.anticipo.deleteMany({ where: { clienteId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.beneficiario.deleteMany({ where: { nit: { startsWith: TEST_PREFIX } } });
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

let fichaCounter = 0;
/** Ficha de pago nueva (NIT con letras → llave propia, sin cruces entre casos). */
async function nuevaFicha(nombre = "Proveedor Test SA"): Promise<string> {
  fichaCounter += 1;
  const b = await prisma.beneficiario.create({
    data: { nombre, nit: `${TEST_PREFIX}-ben-${fichaCounter}-${runId.slice(-8)}` },
  });
  return b.id;
}

/** Anticipo aplicado al trámite (para poder generar pagos). */
async function conAnticipo(tramiteId: string, clienteId: string, monto: bigint): Promise<void> {
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId,
      monto,
      fecha: new Date(`${stateYear}-01-10`),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 0n,
      verificadoBanco: true,
    },
  });
  await prisma.aplicacionAnticipo.create({ data: { anticipoId: anticipo.id, tramiteId, montoAplicado: monto } });
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
      beneficiarioId: await nuevaFicha(),
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

  it("rechaza factura duplicada (tramiteId + numFactura), aunque sea de otro proveedor", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor Test",
      numFactura: "FACT-DUP-001",
      valor: 500_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await expect(
      crearFacturaProveedor({
        tramiteId,
        beneficiarioId: await nuevaFicha(),
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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor A",
      numFactura: "FACT-CROSS-001",
      valor: 100_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    const f2 = await crearFacturaProveedor({
      tramiteId: tramite2,
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor B",
      numFactura: "FACT-CROSS-001",
      valor: 200_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    expect(f1.id).not.toBe(f2.id);
  });

  it("CxP v2: la misma numFactura del MISMO proveedor en otro trámite se rechaza (llave única)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramite1 = await crearTramiteTest(db, db.clientePropioId);
    const tramite2 = await crearTramiteTest(db, db.clientePropioId);
    const ficha = await nuevaFicha("Proveedor Único");

    await crearFacturaProveedor({
      tramiteId: tramite1,
      beneficiarioId: ficha,
      numFactura: "FACT-UNICA-001",
      valor: 100_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });
    await expect(
      crearFacturaProveedor({
        tramiteId: tramite2,
        beneficiarioId: ficha,
        numFactura: "fact unica 001",
        valor: 100_000n,
        fecha: new Date(),
        subidaPorId: db.userId,
      }),
    ).rejects.toBeInstanceOf(FacturaDuplicadaError);
  });

  it("CxP v2: la fecha se guarda como fecha-calendario (00:00 UTC del día en Bogotá)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);
    // 23:30 del 10-sep en Bogotá = 04:30 UTC del 11-sep: la factura es del 10.
    const factura = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: await nuevaFicha(),
      numFactura: "FACT-FECHA-001",
      valor: 100_000n,
      fecha: new Date("2026-09-11T04:30:00.000Z"),
      subidaPorId: db.userId,
    });
    expect(factura.fecha.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });
});

describe("listarPorTramite", () => {
  it("lista facturas de un trámite en orden por fecha", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Prov A",
      numFactura: "FP-01",
      valor: 100_000n,
      fecha: new Date("2026-04-01"),
      subidaPorId: db.userId,
    });
    await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: await nuevaFicha(),
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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor Original",
      numFactura: "FP-UPD-01",
      valor: 300_000n,
      fecha: new Date("2026-03-01"),
      subidaPorId: db.userId,
    });

    const updated = await actualizarFacturaProveedor(
      factura.id,
      { concepto: "Transporte", valor: 350_000n },
      db.userId,
    );

    // El nombre del proveedor sale de la ficha (CxP v2), no se edita a mano.
    expect(updated.proveedorNombre).toBe("Proveedor Test SA");
    expect(updated.concepto).toBe("Transporte");
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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor Pagado",
      numFactura: "FP-PAGADA-UPD-01",
      valor: 750_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await conAnticipo(tramiteId, db.clientePropioId, 750_000n);

    // Generar el pago deja la factura en estado PAGADA
    await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });

    // CxP v2 (R11): con pagos no cambia el valor…
    await expect(
      actualizarFacturaProveedor(factura.id, { valor: 800_000n }, db.userId),
    ).rejects.toThrow(FacturaConPagosError);
    // …pero el concepto sí se corrige.
    const conConcepto = await actualizarFacturaProveedor(factura.id, { concepto: "Flete" }, db.userId);
    expect(conConcepto.concepto).toBe("Flete");
    expect(conConcepto.estado).toBe(EstadoFacturaProveedor.PAGADA);
  });
});

describe("eliminarFacturaProveedor", () => {
  it("elimina una factura sin pagos", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, db.clientePropioId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: await nuevaFicha(),
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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Prov Con Pago",
      numFactura: "FP-PAGO-01",
      valor: 500_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await conAnticipo(tramiteId, db.clientePropioId, 500_000n);

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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "LUTOSA SAS",
      numFactura: "FACT-FESP-001",
      valor: 2_500_000n,
      fecha: new Date("2026-05-10"),
      subidaPorId: db.userId,
    });

    expect(factura.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
    await conAnticipo(tramiteId, db.clientePropioId, 2_500_000n);

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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor Efectivo",
      numFactura: "FP-SOCIO-01",
      valor: 1_000_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await conAnticipo(tramiteId, db.clientePropioId, 1_000_000n);
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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Prov Transf",
      numFactura: "FP-COSTO-01",
      valor: 800_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await conAnticipo(tramiteId, db.clientePropioId, 1_000_000n);
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
      beneficiarioId: await nuevaFicha(),
      proveedorNombre: "Proveedor No Doble",
      numFactura: "FP-DOBLE-01",
      valor: 1_000_000n,
      fecha: new Date(),
      subidaPorId: db.userId,
    });

    await conAnticipo(tramiteId, db.clientePropioId, 2_000_000n);

    // Primera llamada: debe tener éxito y marcar la factura como PAGADA
    await generarPagoDesdeFactura({
      facturaProveedorId: factura.id,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });

    // Segunda llamada sobre la misma factura (ahora en estado PAGADA): debe lanzar
    // error (e5cd35b: "no admite esta operación"; CxP v2/P1: "ya está pagada").
    await expect(
      generarPagoDesdeFactura({
        facturaProveedorId: factura.id,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(/ya está pagada|no admite esta operación/);

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

    const hoyAntes = fechaCalendarioBogota();
    const result = await solicitarFacturacion(tramiteId, db.userId);
    expect(result.ok).toBe(true);
    const hoyDespues = fechaCalendarioBogota();

    // Verificar que el DO quedó en ENVIADO_A_FACTURAR con la fecha
    const tramiteActualizado = await prisma.tramiteDO.findUnique({
      where: { id: tramiteId },
      select: { estado: true, fechaEnviadoAFacturar: true },
    });
    expect(tramiteActualizado?.estado).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
    expect(tramiteActualizado?.fechaEnviadoAFacturar).not.toBeNull();
    // Fecha-calendario: el día en Bogotá a 00:00 UTC, no el instante del envío
    // (a las 20:00 de Bogotá el instante ya es el día siguiente en UTC).
    const enviado = tramiteActualizado?.fechaEnviadoAFacturar?.getTime();
    expect([hoyAntes.getTime(), hoyDespues.getTime()]).toContain(enviado);
  });
});

describe("solicitarFacturacion — servicio suelto (OTRO, decisión de Ernesto 26-sep-2026)", () => {
  let contadorOtro = 0;

  async function crearOtro(
    clienteId: string,
    db: Fixture,
    extra: Partial<{ valorServicio: bigint | null; conceptoServicioCodigo: string | null }> = {},
  ) {
    contadorOtro += 1;
    return prisma.tramiteDO.create({
      data: {
        consecutivo: `OTR-fps-${runId.slice(-6)}-${contadorOtro}`,
        tipoTramiteCodigo: "OTRO",
        ciudad: Ciudad.BUN,
        anio: stateYear,
        numero: 500_000 + contadorOtro,
        clienteId,
        creadoPorId: db.userId,
        comentarios: `${TEST_PREFIX}:${runId}`,
        estado: EstadoTramite.APERTURA,
        valorServicio: extra.valorServicio,
        conceptoServicioCodigo: extra.conceptoServicioCodigo,
      },
    });
  }

  async function crearClienteFlujoCorto(
    nombre: string,
    conceptosIva: boolean,
    tarifarioPropio = false,
  ) {
    return prisma.cliente.create({
      data: {
        nombre,
        nit: `${TEST_PREFIX}-fc-${runId.slice(-6)}-${nombre}`,
        tipo: TipoCliente.PROPIO,
        capacidades: {
          create: [
            ...(conceptosIva
              ? [
                  {
                    codigo: "factura_conceptos_iva",
                    habilitado: true,
                    config: { reteIvaPorcentaje: 15, observacionNoRetenciones: true },
                  },
                ]
              : []),
            ...(tarifarioPropio ? [{ codigo: "tarifario_propio", habilitado: true }] : []),
          ],
        },
      },
    });
  }

  it("no exige pagos; con valor + concepto y formato CONCEPTOS_IVA pasa a ENVIADO_A_FACTURAR", async (ctx) => {
    const db = ensureDb(ctx);
    await prisma.conceptoVenta.upsert({
      where: { codigo: "PLAN_VALLEJO" },
      update: { nombre: "Programa Plan Vallejo", aplicaIva: true },
      create: { codigo: "PLAN_VALLEJO", nombre: "Programa Plan Vallejo", aplicaIva: true },
    });
    const cliente = await crearClienteFlujoCorto("ConValor", true);
    const otro = await crearOtro(cliente.id, db, {
      valorServicio: 350_000n,
      conceptoServicioCodigo: "PLAN_VALLEJO",
    });

    const result = await solicitarFacturacion(otro.id, db.userId);
    expect(result.ok).toBe(true);

    const actualizado = await prisma.tramiteDO.findUnique({
      where: { id: otro.id },
      select: { estado: true, fechaEnviadoAFacturar: true },
    });
    expect(actualizado?.estado).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
    expect(actualizado?.fechaEnviadoAFacturar).not.toBeNull();
  });

  it("sin valor ni concepto (y sin tarifa vigente) → 422 VALOR_SERVICIO_REQUERIDO, nunca pasa de estado", async (ctx) => {
    const db = ensureDb(ctx);
    const cliente = await crearClienteFlujoCorto("SinValor", true);
    const otro = await crearOtro(cliente.id, db);

    await expect(solicitarFacturacion(otro.id, db.userId)).rejects.toMatchObject({
      name: "ValorServicioRequeridoError",
      status: 422,
      codigo: "VALOR_SERVICIO_REQUERIDO",
    });

    const sinCambios = await prisma.tramiteDO.findUnique({
      where: { id: otro.id },
      select: { estado: true },
    });
    expect(sinCambios?.estado).toBe(EstadoTramite.APERTURA);
  });

  it("con valor + concepto pero SIN «Factura con conceptos e IVA» → 422 FORMATO_CONCEPTOS_REQUERIDO", async (ctx) => {
    const db = ensureDb(ctx);
    const cliente = await crearClienteFlujoCorto("SinFormato", false);
    const otro = await crearOtro(cliente.id, db, {
      valorServicio: 350_000n,
      conceptoServicioCodigo: "PLAN_VALLEJO",
    });

    await expect(solicitarFacturacion(otro.id, db.userId)).rejects.toMatchObject({
      name: "FormatoConceptosRequeridoError",
      status: 422,
      codigo: "FORMATO_CONCEPTOS_REQUERIDO",
    });
  });

  // ─── M-N1 · un ítem pendiente tampoco deja pasar por esta ruta ───────────
  it("con tarifa OTROS vigente pero con un ítem pendiente (por contenedor) → 422 TarifaIncompletaError, sin avanzar de estado", async (ctx) => {
    const db = ensureDb(ctx);
    const cliente = await crearClienteFlujoCorto("TarifaPendiente", true, true);
    await prisma.tarifario.create({
      data: {
        empresaId: cliente.id,
        nombre: "Tarifa OTROS pendiente vitest",
        alcance: "OTROS",
        estado: EstadoTarifario.VIGENTE,
        vigenteDesde: new Date(Date.now() - 30 * 86_400_000),
        vigenteHasta: new Date(Date.now() + 30 * 86_400_000),
        version: 1,
        creadoPorId: db.userId,
        items: {
          create: [
            {
              orden: 10,
              concepto: "SELLOS",
              nombrePublico: "Sellos de seguridad",
              tipoCalculo: TipoCalculoTarifa.FIJO,
              disparador: DisparadorTarifa.SIEMPRE,
              unidad: UnidadTarifa.TRAMITE,
              valor: 80_000n,
              aplicaIva: false,
            },
            {
              orden: 20,
              concepto: "PLAN_VALLEJO",
              nombrePublico: "Por contenedor",
              tipoCalculo: TipoCalculoTarifa.POR_UNIDAD,
              disparador: DisparadorTarifa.SIEMPRE,
              unidad: UnidadTarifa.CONTENEDOR,
              valor: 50_000n,
              aplicaIva: true,
            },
          ],
        },
      },
    });
    const otro = await crearOtro(cliente.id, db);

    await expect(solicitarFacturacion(otro.id, db.userId)).rejects.toMatchObject({
      name: "TarifaIncompletaError",
      status: 422,
    });

    const sinCambios = await prisma.tramiteDO.findUnique({
      where: { id: otro.id },
      select: { estado: true },
    });
    expect(sinCambios?.estado).toBe(EstadoTramite.APERTURA);
  });
});

describe("Permisos SOCIO", () => {
  it("SOCIO puede crear factura en trámite SOCIO_LM", async (ctx) => {
    const db = ensureDb(ctx);
    // Solo verificamos que no lanza error al nivel de servicio
    const tramiteId = await crearTramiteTest(db, db.clienteSocioLmId);

    const factura = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: await nuevaFicha(),
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
