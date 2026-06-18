/**
 * Tests de integración — Libro de pagos del trámite (A1-T6)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-pagos"
 * Año de datos de prueba: 3002 (no colisiona con datos reales)
 */
import "dotenv/config";

import { AgenciaAduanas, CanalPago, Ciudad, EstadoFacturaProveedor, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { FacturaProveedorNoModificableError } from "@/lib/facturas-proveedor/service";
import {
  MatrizCanalNoEncontradoError,
  PagoFacturaDeOtroTramiteError,
  actualizarPago,
  crearPago,
  eliminarPago,
  getLibroPagos,
} from "../service";

// ─── Constantes del test ─────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-pagos";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3002;

// ─── Fixture ─────────────────────────────────────────────────────────────────

type Fixture = {
  clienteId: string;
  userId: string;
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

  // Eliminar en orden correcto respetando FK constraints
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
      ],
    },
  });
  await prisma.aplicacionAnticipo.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  // Desvincular PagoTramite de FacturaProveedor antes de borrar (onDelete: SetNull)
  // y borrar FacturaProveedor antes de PagoTramite para evitar violaciones de FK.
  await prisma.pagoTramite.updateMany({
    where: { tramiteId: { in: tramiteIds } },
    data: { facturaProveedorId: null },
  });
  await prisma.facturaProveedor.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.pagoTramite.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });

  // Limpiar anticipos del cliente de test
  const testAnticipos = await prisma.anticipo.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const anticipoIds = testAnticipos.map((a) => a.id);
  await prisma.aplicacionAnticipo.deleteMany({
    where: { anticipoId: { in: anticipoIds } },
  });
  await prisma.anticipo.deleteMany({
    where: { id: { in: anticipoIds } },
  });

  await prisma.checklistItem.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.tramiteDO.deleteMany({
    where: { id: { in: tramiteIds } },
  });
  await prisma.cliente.deleteMany({
    where: { id: { in: clienteIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Pagos",
      rol: Rol.ADMIN,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Pagos",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de pagos",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }

  return fixture;
}

/**
 * Crea un TramiteDO directo en BD (sin lógica de consecutivo) para los tests.
 */
async function crearTramiteTest(
  db: Fixture,
  numero: number,
): Promise<string> {
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId: db.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.userId,
      comentarios: `${TEST_PREFIX}:${runId}`,
    },
  });

  return tramite.id;
}

/**
 * Crea una AplicacionAnticipo directamente para simular el anticipo aplicado al DO.
 */
async function aplicarAnticipoTest(
  db: Fixture,
  tramiteId: string,
  monto: bigint,
): Promise<void> {
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: db.clienteId,
      monto,
      fecha: new Date("3002-01-10"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 1_950n,
      verificadoBanco: true,
    },
  });

  await prisma.aplicacionAnticipo.create({
    data: {
      anticipoId: anticipo.id,
      tramiteId,
      montoAplicado: monto,
    },
  });
}

/**
 * Crea una FacturaProveedor de prueba en estado REGISTRADA.
 */
async function crearFacturaProveedorTest(
  db: Fixture,
  tramiteId: string,
  numFactura: string,
  valor: bigint,
): Promise<string> {
  const fp = await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "Proveedor Vitest",
      numFactura,
      valor,
      fecha: new Date("3002-02-01"),
      subidaPorId: db.userId,
    },
  });
  return fp.id;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("pagos service con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason =
        "DATABASE_URL no está definida; se omiten tests de integración con Postgres";
      return;
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
      await cleanupTestData();
      fixture = await createFixture();
    } catch (error) {
      dbUnavailableReason = `BD local Postgres no disponible: ${unavailableMessage(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) {
      await cleanupTestData();
    }

    await prisma.$disconnect();
  });

  // ─── TEST DORADO (saldo) DO.BUN26-0026 ────────────────────────────────────
  it("TEST DORADO DO.BUN26-0026: saldoFinal = 4.708.356 exacto (tolerancia 0)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 26);

    // Anticipo aplicado: 45.226.000
    await aplicarAnticipoTest(db, tramiteId, 45_226_000n);

    /**
     * Pagos en orden (valores del Excel GRUPO E PAPIS 2026 DO.BUN26-0026):
     * Canal asignado de forma determinista:
     * - Pagos 1, 2, 7 → BANCOLOMBIA_TRANSFERENCIA (costoFijo = 3.900)
     * - Pagos 3, 4, 5, 6 → PSE (costoFijo = 0)
     *
     * costosBancarios esperado = 3 × 3.900 = 11.700
     *
     * TODO(A1-T7): reconciliar costos bancarios reales (17.550) con la asignación
     * de canal por pago del Excel GRUPO E PAPIS 2026. La asignación exacta de canal
     * por pago no está confirmada en el documento de requerimientos (internamente
     * inconsistente: "3×3.900" da 11.700, no 17.550). El valor bloqueante es
     * saldoFinal = 4.708.356 (exacto, tolerancia 0).
     */
    const pagosConfig: Array<{ valor: bigint; canal: CanalPago }> = [
      { valor: 1_000_000n, canal: CanalPago.TRANSF_BANCOLOMBIA },
      { valor: 2_011_341n, canal: CanalPago.TRANSF_BANCOLOMBIA },
      { valor: 30_854_000n, canal: CanalPago.PSE },
      { valor: 2_216_233n, canal: CanalPago.PSE },
      { valor: 760_283n, canal: CanalPago.PSE },
      { valor: 175_787n, canal: CanalPago.PSE },
      { valor: 3_500_000n, canal: CanalPago.TRANSF_BANCOLOMBIA },
    ];

    for (const cfg of pagosConfig) {
      await crearPago({
        tramiteId,
        concepto: `Pago test ${cfg.valor}`,
        valor: cfg.valor,
        canalPago: cfg.canal,
        usuarioId: db.userId,
      });
    }

    const libro = await getLibroPagos(tramiteId);

    // Verificar anticipo aplicado
    expect(libro.totalAnticipoAplicado).toBe(45_226_000n);

    // Verificar total de pagos: suma exacta
    const totalEsperado =
      1_000_000n +
      2_011_341n +
      30_854_000n +
      2_216_233n +
      760_283n +
      175_787n +
      3_500_000n;
    // = 40.517.644
    expect(libro.totalPagos).toBe(totalEsperado);

    // ─── CRITERIO BLOQUEANTE ────────────────────────────────────────────────
    // saldoFinal = 45.226.000 − 40.517.644 = 4.708.356 (tolerancia: 0 pesos)
    expect(libro.saldoFinal).toBe(4_708_356n);

    // Verificar saldos intermedios exactos
    const saldosEsperados: bigint[] = [
      45_226_000n - 1_000_000n,                        // 44.226.000
      45_226_000n - 1_000_000n - 2_011_341n,           // 42.214.659
      45_226_000n - 1_000_000n - 2_011_341n - 30_854_000n, // 11.360.659
      45_226_000n - 1_000_000n - 2_011_341n - 30_854_000n - 2_216_233n, // 9.144.426
      45_226_000n - 1_000_000n - 2_011_341n - 30_854_000n - 2_216_233n - 760_283n, // 8.384.143
      45_226_000n - 1_000_000n - 2_011_341n - 30_854_000n - 2_216_233n - 760_283n - 175_787n, // 8.208.356
      4_708_356n, // saldo final
    ];

    expect(libro.saldos).toHaveLength(7);
    for (let i = 0; i < saldosEsperados.length; i++) {
      expect(libro.saldos[i], `saldo intermedio índice ${i}`).toBe(
        saldosEsperados[i],
      );
    }

    // costosBancarios = 3 × 3.900 = 11.700 (determinista con los canales asignados)
    expect(libro.costosBancarios).toBe(11_700n);
  });

  // ─── Cambiar canal recalcula costoBancario en cascada ─────────────────────
  it("cambiar canal PSE → BANCOLOMBIA_TRANSFERENCIA recalcula costosBancarios (+3.900)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 100);
    await aplicarAnticipoTest(db, tramiteId, 10_000_000n);

    // Crear dos pagos: uno PSE, uno BANCOLOMBIA_TRANSFERENCIA
    const pagoPse = await crearPago({
      tramiteId,
      concepto: "Pago PSE",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });

    await crearPago({
      tramiteId,
      concepto: "Pago transferencia",
      valor: 500_000n,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      usuarioId: db.userId,
    });

    const libroAntes = await getLibroPagos(tramiteId);
    // costos antes: 0 (PSE) + 3.900 (transferencia) = 3.900
    expect(libroAntes.costosBancarios).toBe(3_900n);

    // Cambiar el pago PSE a BANCOLOMBIA_TRANSFERENCIA
    await actualizarPago(
      pagoPse.id,
      { canalPago: CanalPago.TRANSF_BANCOLOMBIA },
      db.userId,
    );

    const libroDespues = await getLibroPagos(tramiteId);
    // costos después: 3.900 + 3.900 = 7.800 (+3.900 vs antes)
    expect(libroDespues.costosBancarios).toBe(7_800n);
    expect(libroDespues.costosBancarios - libroAntes.costosBancarios).toBe(
      3_900n,
    );
  });

  // ─── Canal inexistente en la matriz → error 400 ───────────────────────────
  it("canal inexistente en la matriz → lanza MatrizCanalNoEncontradoError (status 400)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 200);

    /**
     * CanalPago es un enum de Prisma que refleja los valores del schema.
     * Todos los valores del enum tienen entrada en la matriz (seedeada).
     * Para probar el path de error, borramos temporalmente la fila PSE
     * de la matriz y la restauramos al finalizar.
     */
    const canalBorrado = CanalPago.PSE;

    // Guarda el valor original para restaurar
    const original = await prisma.matrizPago.findUnique({
      where: { canalPago: canalBorrado },
    });

    if (!original) {
      ctx.skip("Fila PSE no encontrada en la matriz de recaudo — seed faltante");
      return;
    }

    // Eliminar temporalmente la fila de la matriz para PSE
    await prisma.matrizPago.delete({ where: { canalPago: canalBorrado } });

    try {
      await expect(
        crearPago({
          tramiteId,
          concepto: "Pago con canal eliminado",
          valor: 1_000_000n,
          canalPago: canalBorrado,
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(MatrizCanalNoEncontradoError);

      // Verificar que el pago NO fue creado (transacción abortada)
      const pagos = await prisma.pagoTramite.findMany({
        where: { tramiteId },
      });
      expect(pagos).toHaveLength(0);
    } finally {
      // Restaurar la fila eliminada
      await prisma.matrizPago.create({
        data: {
          id: original.id,
          canalPago: original.canalPago,
          descripcion: original.descripcion,
          costoFijo: original.costoFijo,
        },
      });
    }
  });

  // ─── Tests adicionales ────────────────────────────────────────────────────

  it("getLibroPagos sin pagos retorna saldoFinal = totalAnticipoAplicado", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 300);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);

    const libro = await getLibroPagos(tramiteId);

    expect(libro.pagos).toHaveLength(0);
    expect(libro.saldos).toHaveLength(0);
    expect(libro.totalPagos).toBe(0n);
    expect(libro.costosBancarios).toBe(0n);
    expect(libro.totalAnticipoAplicado).toBe(5_000_000n);
    expect(libro.saldoFinal).toBe(5_000_000n);
  });

  it("eliminarPago reduce el total de pagos y recalcula el saldo", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 400);
    await aplicarAnticipoTest(db, tramiteId, 10_000_000n);

    const pago1 = await crearPago({
      tramiteId,
      concepto: "Pago 1",
      valor: 3_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });

    await crearPago({
      tramiteId,
      concepto: "Pago 2",
      valor: 2_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });

    const libroCon2 = await getLibroPagos(tramiteId);
    expect(libroCon2.totalPagos).toBe(5_000_000n);
    expect(libroCon2.saldoFinal).toBe(5_000_000n);

    await eliminarPago(pago1.id, db.userId);

    const libroCon1 = await getLibroPagos(tramiteId);
    expect(libroCon1.pagos).toHaveLength(1);
    expect(libroCon1.totalPagos).toBe(2_000_000n);
    expect(libroCon1.saldoFinal).toBe(8_000_000n);
  });

  it("crearPago asigna costoBancario correcto desde la matriz", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 500);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago transferencia otros bancos",
      valor: 1_000_000n,
      canalPago: CanalPago.TRANSF_OTROS_BANCOS,
      usuarioId: db.userId,
    });

    // TRANSF_OTROS_BANCOS = 7.300 según la matriz de pagos
    expect(pago.costoBancario).toBe(7_300n);
  });

  it("los pagos se retornan ordenados por campo 'orden' ascendente", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 600);
    await aplicarAnticipoTest(db, tramiteId, 20_000_000n);

    const valores = [5_000_000n, 3_000_000n, 7_000_000n];
    for (const valor of valores) {
      await crearPago({
        tramiteId,
        concepto: `Pago ${valor}`,
        valor,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
      });
    }

    const libro = await getLibroPagos(tramiteId);
    expect(libro.pagos.map((p) => p.valor)).toEqual(valores);
    // Orden asignado secuencialmente: 1, 2, 3
    expect(libro.pagos.map((p) => p.orden)).toEqual([1, 2, 3]);
  });

  // ─── Tests de vinculación con FacturaProveedor ───────────────────────────

  it("crearPago vinculado a una FacturaProveedor REGISTRADA la marca como PAGADA y guarda el vínculo", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 700);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-700-001", 2_000_000n);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago vinculado a FP",
      valor: 2_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      facturaProveedorId: fpId,
    });

    // El pago debe tener el vínculo guardado
    expect(pago.facturaProveedorId).toBe(fpId);

    // La FP debe haber quedado en estado PAGADA
    const fpActualizada = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
    expect(fpActualizada?.estado).toBe(EstadoFacturaProveedor.PAGADA);
  });

  it("crearPago con facturaProveedorId de una FP ya PAGADA lanza FacturaProveedorNoModificableError y no crea el pago", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 800);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-800-001", 3_000_000n);

    // Primer pago: vincula y marca PAGADA
    await crearPago({
      tramiteId,
      concepto: "Primer pago",
      valor: 3_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      facturaProveedorId: fpId,
    });

    // Segundo pago sobre la misma FP ya PAGADA → debe lanzar error
    await expect(
      crearPago({
        tramiteId,
        concepto: "Segundo pago sobre FP ya pagada",
        valor: 1_000_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
        facturaProveedorId: fpId,
      }),
    ).rejects.toThrow(FacturaProveedorNoModificableError);

    // Verificar que el segundo pago NO fue creado
    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId } });
    expect(pagos).toHaveLength(1);
  });

  it("crearPago con facturaProveedorId de OTRO trámite lanza PagoFacturaDeOtroTramiteError", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId1 = await crearTramiteTest(db, 900);
    const tramiteId2 = await crearTramiteTest(db, 901);

    // FP pertenece al trámite 1
    const fpId = await crearFacturaProveedorTest(db, tramiteId1, "FP-900-001", 1_500_000n);

    // Intentar vincular esa FP al crear un pago del trámite 2 → error
    await expect(
      crearPago({
        tramiteId: tramiteId2,
        concepto: "Pago con FP de otro trámite",
        valor: 1_500_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
        facturaProveedorId: fpId,
      }),
    ).rejects.toThrow(PagoFacturaDeOtroTramiteError);

    // Verificar que no se creó ningún pago en tramiteId2
    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteId2 } });
    expect(pagos).toHaveLength(0);
  });

  it("eliminarPago de un pago vinculado revierte la FacturaProveedor a REGISTRADA", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1000);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-1000-001", 2_500_000n);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago a eliminar",
      valor: 2_500_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      facturaProveedorId: fpId,
    });

    // Confirmar que la FP está PAGADA
    const fpPagada = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
    expect(fpPagada?.estado).toBe(EstadoFacturaProveedor.PAGADA);

    // Eliminar el pago
    await eliminarPago(pago.id, db.userId);

    // La FP debe haber vuelto a REGISTRADA
    const fpRevertida = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
    expect(fpRevertida?.estado).toBe(EstadoFacturaProveedor.REGISTRADA);

    // El pago ya no existe
    const pagoBorrado = await prisma.pagoTramite.findUnique({ where: { id: pago.id } });
    expect(pagoBorrado).toBeNull();
  });

  it("crearPago sin facturaProveedorId sigue funcionando (no rompe el flujo manual)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1100);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago manual sin FP",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });

    expect(pago.facturaProveedorId).toBeNull();

    const libro = await getLibroPagos(tramiteId);
    expect(libro.pagos).toHaveLength(1);
    expect(libro.saldoFinal).toBe(4_000_000n);
  });
});
