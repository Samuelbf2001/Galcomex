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

import { AgenciaAduanas, CanalPago, CategoriaDocumento, Ciudad, EstadoFacturaProveedor, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crearFichaConEmpresaTest } from "@/lib/beneficiarios/__tests__/fixtures";
import { FacturaDeOtroDoError, FacturaSinSaldoError, MontoExcedeSaldoError } from "@/lib/cxp/errores";
import { cargarContextoDos } from "@/lib/cxp/pagabilidad-bd";
import { prisma } from "@/lib/db/prisma";
import {
  DocumentoDeOtroTramiteError,
  DocumentoNoEncontradoParaPagoError,
  MatrizCanalNoEncontradoError,
  SinAnticipoAplicadoError,
  SinAnticipoAplicadoMultiDOError,
  actualizarPago,
  crearPago,
  crearPagoMultiDO,
  eliminarPago,
  getLibroPagos,
  listarFacturasElegiblesMultiDO,
  listarPagosGlobal,
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
  // Borradores (y sus líneas/enlaces a facturas) antes que las facturas.
  await prisma.borradorFactura.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  // Desvincular PagoTramite de FacturaProveedor (pivot N↔N) antes de borrar
  // y borrar FacturaProveedor antes de PagoTramite para evitar violaciones de FK.
  await prisma.pagoTramiteFactura.deleteMany({
    where: { pago: { tramiteId: { in: tramiteIds } } },
  });
  await prisma.facturaProveedor.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  // CxP v2: cabeceras PagoGrupo de los bloques de prueba (después de sus
  // PagoTramite: FK pago_tramite.grupoPagoId → pago_grupo).
  const grupos = await prisma.pagoTramite.findMany({
    where: { tramiteId: { in: tramiteIds }, grupoPagoId: { not: null } },
    select: { grupoPagoId: true },
  });
  await prisma.pagoTramite.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.pagoGrupo.deleteMany({
    where: {
      OR: [
        { id: { in: grupos.flatMap((g) => (g.grupoPagoId ? [g.grupoPagoId] : [])) } },
        { creadoPorId: { in: userIds } },
      ],
    },
  });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: clienteIds } } });

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
  // Beneficiarios de prueba (pago multi-DO) — el pivot pago_tramite_beneficiario
  // ya fue borrado en cascada al eliminar pagoTramite arriba. Fase 3: la FK
  // ficha → empresa es Restrict, así que las fichas se borran ANTES que las empresas.
  await prisma.beneficiario.deleteMany({
    where: { OR: [{ nit: { startsWith: TEST_PREFIX } }, { empresaId: { in: clienteIds } }] },
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
  clienteId: string = db.clienteId,
): Promise<string> {
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId,
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
 * CxP v2 (R7): toda factura pagable tiene ficha de pago; si no se pasa
 * `beneficiarioId`, se crea una ficha "Proveedor Vitest" propia.
 */
async function crearFacturaProveedorTest(
  db: Fixture,
  tramiteId: string,
  numFactura: string,
  valor: bigint,
  beneficiarioId?: string,
): Promise<string> {
  const fp = await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "Proveedor Vitest",
      beneficiarioId: beneficiarioId ?? (await crearBeneficiarioTest("Proveedor Vitest")),
      numFactura,
      valor,
      fecha: new Date("3002-02-01"),
      subidaPorId: db.userId,
    },
  });
  return fp.id;
}

/**
 * Crea un Beneficiario de prueba (nit prefijado con TEST_PREFIX para limpieza).
 */
async function crearBeneficiarioTest(nombre: string): Promise<string> {
  // Fase 3: la ficha lleva su empresa (mismo NIT con prefijo de prueba, que borra `cleanupTestData`).
  const b = await crearFichaConEmpresaTest({
    nombre,
    nit: `${TEST_PREFIX}-${runId}-${Math.random().toString(36).slice(2)}`,
  });
  return b.id;
}

/**
 * Crea un Documento de prueba (comprobante) vinculado a un trámite.
 */
async function crearDocumentoTest(
  db: Fixture,
  tramiteId: string,
  categoria: CategoriaDocumento = CategoriaDocumento.COMPROBANTE_BANCARIO,
): Promise<string> {
  const doc = await prisma.documento.create({
    data: {
      tramiteId,
      categoria,
      nombreArchivo: "comprobante-vitest.pdf",
      storageKey: `vitest/${runId}/${Math.random().toString(36).slice(2)}.pdf`,
      mimeType: "application/pdf",
      tamanoBytes: 1024,
      subidoPorId: db.userId,
    },
  });
  return doc.id;
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
    await aplicarAnticipoTest(db, tramiteId, 2_000_000n);

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
    await aplicarAnticipoTest(db, tramiteId, 2_000_000n);

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
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-700-001", 2_000_000n);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago vinculado a FP",
      valor: 2_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      facturaProveedorIds: [fpId],
    });

    // El pago debe tener el vínculo guardado (pivot N↔N)
    const vinculo = await prisma.pagoTramiteFactura.findFirst({
      where: { pagoId: pago.id, facturaId: fpId },
    });
    expect(vinculo).not.toBeNull();

    // La FP debe haber quedado en estado PAGADA
    const fpActualizada = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
    expect(fpActualizada?.estado).toBe(EstadoFacturaProveedor.PAGADA);
  });

  // CxP v2 (decisión de Ernesto, PRD 13.19): se INVIERTE la decisión anterior.
  // Una factura PAGADA no se vuelve a pagar por ningún camino (FACTURA_SIN_SALDO).
  it("crearPago sobre una FP ya PAGADA se rechaza (FACTURA_SIN_SALDO) y no crea ni enlaza nada", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 800);
    await aplicarAnticipoTest(db, tramiteId, 10_000_000n);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-800-001", 3_000_000n);

    await crearPago({
      tramiteId,
      concepto: "Primer pago",
      valor: 3_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      facturaProveedorIds: [fpId],
    });

    await expect(
      crearPago({
        tramiteId,
        concepto: "Segundo pago sobre FP ya pagada",
        valor: 1_000_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
        facturaProveedorIds: [fpId],
      }),
    ).rejects.toThrow(FacturaSinSaldoError);

    const fpFinal = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
    expect(fpFinal?.estado).toBe(EstadoFacturaProveedor.PAGADA);
    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId } });
    expect(pagos).toHaveLength(1);
    const vinculos = await prisma.pagoTramiteFactura.findMany({ where: { facturaId: fpId } });
    expect(vinculos).toHaveLength(1);
    expect(vinculos[0]!.monto).toBe(3_000_000n);
  });

  it("dos abonos por `aplicaciones` dejan la FP PARCIAL y luego PAGADA; un tercero se rechaza", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 810);
    await aplicarAnticipoTest(db, tramiteId, 10_000_000n);
    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-810-001", 300_000n);

    await crearPago({
      tramiteId,
      concepto: "Abono 1",
      valor: 100_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: fpId, monto: 100_000n }],
      usuarioId: db.userId,
    });
    let fp = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: fpId } });
    expect(fp.estado).toBe(EstadoFacturaProveedor.PARCIAL);

    // Pagar más que el saldo (200.000) se rechaza con el mensaje exacto.
    await expect(
      crearPago({
        tramiteId,
        concepto: "Abono de más",
        valor: 300_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: fpId, monto: 300_000n }],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow("A la factura FP-810-001 solo le faltan $200.000 por pagar; no se le pueden aplicar $300.000.");

    await crearPago({
      tramiteId,
      concepto: "Abono 2",
      valor: 200_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: fpId, monto: 200_000n }],
      usuarioId: db.userId,
    });
    fp = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: fpId } });
    expect(fp.estado).toBe(EstadoFacturaProveedor.PAGADA);

    await expect(
      crearPago({
        tramiteId,
        concepto: "Abono 3",
        valor: 1n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: fpId, monto: 1n }],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(/ya está pagada/);

    const libro = await getLibroPagos(tramiteId);
    expect(libro.pagos.map((p) => p.aplicaciones.map((a) => a.monto))).toEqual([[100_000n], [200_000n]]);
    expect(libro.pagos.every((p) => p.tieneFacturas && !p.editableDinero && !p.esBloque)).toBe(true);
  });

  it("aplicaciones que no suman el valor del pago → PAGO_NO_CUADRA; valor mayor que los saldos (heredado) → PAGO_EXCEDE_SALDO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 820);
    await aplicarAnticipoTest(db, tramiteId, 10_000_000n);
    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-820-001", 464_077n);

    await expect(
      crearPago({
        tramiteId,
        concepto: "No cuadra",
        valor: 500_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: fpId, monto: 464_077n }],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow("El valor del pago ($500.000) debe ser igual a lo aplicado a las facturas ($464.077).");

    await expect(
      crearPago({
        tramiteId,
        concepto: "Pago de más",
        valor: 928_154n,
        canalPago: CanalPago.PSE,
        facturaProveedorIds: [fpId],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(
      "El pago ($928.154) es mayor que lo que falta por pagar de las facturas escogidas ($464.077). No se puede pagar de más.",
    );

    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(0);
  });

  it("entrada heredada: el valor que no alcanza para todas las facturas → FACTURA_SIN_MONTO (nunca enlaza a medias)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 830);
    await aplicarAnticipoTest(db, tramiteId, 10_000_000n);
    const beneficiarioId = await crearBeneficiarioTest("Proveedor FIFO");
    const a = await crearFacturaProveedorTest(db, tramiteId, "FE-830-A", 200_000n, beneficiarioId);
    const b = await crearFacturaProveedorTest(db, tramiteId, "FE-830-B", 150_000n, beneficiarioId);

    await expect(
      crearPago({
        tramiteId,
        concepto: "Solo alcanza para una",
        valor: 200_000n,
        canalPago: CanalPago.PSE,
        facturaProveedorIds: [a, b],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow("El valor ($200.000) solo alcanza para FE-830-A; quita las demás facturas o indica el monto de cada una.");

    // Un valor que cubre una y abona la otra se reparte FIFO (fecha, creación).
    const pago = await crearPago({
      tramiteId,
      concepto: "FIFO",
      valor: 250_000n,
      canalPago: CanalPago.PSE,
      facturaProveedorIds: [b, a],
      usuarioId: db.userId,
    });
    const puentes = await prisma.pagoTramiteFactura.findMany({ where: { pagoId: pago.id } });
    const porFactura = new Map(puentes.map((p) => [p.facturaId, p.monto]));
    expect(porFactura.get(a)).toBe(200_000n);
    expect(porFactura.get(b)).toBe(50_000n);
    // El pago sin beneficiarios quedó con el proveedor de sus facturas.
    const benef = await prisma.pagoTramiteBeneficiario.findMany({ where: { pagoId: pago.id } });
    expect(benef.map((x) => x.beneficiarioId)).toEqual([beneficiarioId]);
  });

  it("crearPago con facturaProveedorId de OTRO trámite lanza FacturaDeOtroDoError", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId1 = await crearTramiteTest(db, 900);
    const tramiteId2 = await crearTramiteTest(db, 901);
    await aplicarAnticipoTest(db, tramiteId2, 5_000_000n);

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
        facturaProveedorIds: [fpId],
      }),
    ).rejects.toThrow(FacturaDeOtroDoError);

    // Verificar que no se creó ningún pago en tramiteId2
    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteId2 } });
    expect(pagos).toHaveLength(0);
  });

  it("eliminarPago de un pago vinculado revierte la FacturaProveedor a REGISTRADA", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1000);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-1000-001", 2_500_000n);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago a eliminar",
      valor: 2_500_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      facturaProveedorIds: [fpId],
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

    const vinculos = await prisma.pagoTramiteFactura.findMany({
      where: { pagoId: pago.id },
    });
    expect(vinculos).toHaveLength(0);

    const libro = await getLibroPagos(tramiteId);
    expect(libro.pagos).toHaveLength(1);
    expect(libro.saldoFinal).toBe(4_000_000n);
  });

  // ─── B3: sin anticipo → SinAnticipoAplicadoError ─────────────────────────

  it("crearPago sin anticipo aplicado lanza SinAnticipoAplicadoError (status 422)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1200);

    await expect(
      crearPago({
        tramiteId,
        concepto: "Pago sin anticipo",
        valor: 1_000_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(SinAnticipoAplicadoError);

    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId } });
    expect(pagos).toHaveLength(0);
  });

  it("un costo propio (factura no repercutible) se paga aunque el DO no tenga anticipo", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1250);
    // La clasificadora: la paga Galcomex, no sale del anticipo del cliente.
    const propia = await crearFacturaProveedorTest(db, tramiteId, `${runId}-CLAS`, 250_000n);
    await prisma.facturaProveedor.update({ where: { id: propia }, data: { repercutible: false } });

    const pago = await crearPago({
      tramiteId,
      concepto: "Clasificación arancelaria — informe 2140",
      valor: 250_000n,
      canalPago: CanalPago.PSE,
      facturaProveedorIds: [propia],
      usuarioId: db.userId,
    });
    expect(pago.valor).toBe(250_000n);

    // Una factura que sí se le cobra al cliente sigue exigiendo anticipo.
    const deTercero = await crearFacturaProveedorTest(db, tramiteId, `${runId}-TER`, 100_000n);
    await expect(
      crearPago({
        tramiteId,
        concepto: "Pago de tercero sin anticipo",
        valor: 100_000n,
        canalPago: CanalPago.PSE,
        facturaProveedorIds: [deTercero],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(SinAnticipoAplicadoError);
  });

  it("una empresa a crédito (sin la capacidad anticipos_cliente) paga terceros sin anticipo", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1260);
    // Polyrec ZF, CW ASIA, Sesderma, Coldex…: Galcomex adelanta el puerto y lo cobra en la factura.
    await prisma.empresaCapacidad.upsert({
      where: { empresaId_codigo: { empresaId: db.clienteId, codigo: "anticipos_cliente" } },
      create: { empresaId: db.clienteId, codigo: "anticipos_cliente", habilitado: false },
      update: { habilitado: false },
    });
    try {
      const deTercero = await crearFacturaProveedorTest(db, tramiteId, `${runId}-CRED`, 262_750n);
      const pago = await crearPago({
        tramiteId,
        concepto: "VACIO SPRB FACT. 1003997130",
        valor: 262_750n,
        canalPago: CanalPago.PSE,
        facturaProveedorIds: [deTercero],
        usuarioId: db.userId,
      });
      expect(pago.valor).toBe(262_750n);
    } finally {
      await prisma.empresaCapacidad.deleteMany({ where: { empresaId: db.clienteId, codigo: "anticipos_cliente" } });
    }
  });

  it("crearPago con anticipo no verificado (REALIZADO) se permite sin error", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1300);

    const anticipo = await prisma.anticipo.create({
      data: {
        clienteId: db.clienteId,
        monto: 5_000_000n,
        fecha: new Date("3002-01-10"),
        tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
        costoRecaudo: 1_950n,
        verificadoBanco: false,
        estado: "REALIZADO",
      },
    });
    await prisma.aplicacionAnticipo.create({
      data: { anticipoId: anticipo.id, tramiteId, montoAplicado: 5_000_000n },
    });

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago con anticipo no verificado",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });

    expect(pago.id).toBeTruthy();
    const libro = await getLibroPagos(tramiteId);
    expect(libro.pagos).toHaveLength(1);
    expect(libro.saldoFinal).toBe(4_000_000n);
  });

  // ─── Doble comprobante: documentoId / comprobanteComercioId ─────────────

  it("crearPago con comprobanteComercioId válido del mismo trámite lo guarda", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1460);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);
    const docId = await crearDocumentoTest(db, tramiteId, CategoriaDocumento.COMPROBANTE_COMERCIO);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago con comprobante de comercio",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      comprobanteComercioId: docId,
    });

    expect(pago.comprobanteComercioId).toBe(docId);
  });

  it("crearPago con comprobanteComercioId de OTRO trámite lanza DocumentoDeOtroTramiteError", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId1 = await crearTramiteTest(db, 1450);
    const tramiteId2 = await crearTramiteTest(db, 1451);
    await aplicarAnticipoTest(db, tramiteId2, 5_000_000n);

    const docId = await crearDocumentoTest(db, tramiteId1, CategoriaDocumento.COMPROBANTE_COMERCIO);

    await expect(
      crearPago({
        tramiteId: tramiteId2,
        concepto: "Pago con comprobante de otro trámite",
        valor: 1_000_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
        comprobanteComercioId: docId,
      }),
    ).rejects.toThrow(DocumentoDeOtroTramiteError);

    const pagos = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteId2 } });
    expect(pagos).toHaveLength(0);
  });

  it("crearPago con comprobanteComercioId inexistente lanza DocumentoNoEncontradoParaPagoError", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1470);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);

    await expect(
      crearPago({
        tramiteId,
        concepto: "Pago con comprobante inexistente",
        valor: 1_000_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
        comprobanteComercioId: "id-inexistente",
      }),
    ).rejects.toThrow(DocumentoNoEncontradoParaPagoError);
  });

  // ─── Adjuntar comprobante bancario después de guardar el pago ────────────
  // Decisión del dueño: se puede guardar un pago SIN comprobante y adjuntarlo
  // después; mientras falte, `faltaComprobante` debe quedar true (alerta, no
  // bloqueo — caso Karina).

  it("faltaComprobante = true al crear sin documentoId y false tras actualizarPago con el comprobante", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1480);
    await aplicarAnticipoTest(db, tramiteId, 3_000_000n);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago sin comprobante bancario",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
    });
    expect(pago.documentoId).toBeNull();

    const libroAntes = await getLibroPagos(tramiteId);
    const filaAntes = libroAntes.pagos.find((p) => p.id === pago.id);
    expect(filaAntes?.faltaComprobante).toBe(true);

    // El PATCH acepta agregar el comprobante bancario a un pago ya guardado.
    const docId = await crearDocumentoTest(db, tramiteId, CategoriaDocumento.COMPROBANTE_BANCARIO);
    const actualizado = await actualizarPago(pago.id, { documentoId: docId }, db.userId);
    expect(actualizado.documentoId).toBe(docId);

    const libroDespues = await getLibroPagos(tramiteId);
    const filaDespues = libroDespues.pagos.find((p) => p.id === pago.id);
    expect(filaDespues?.documentoId).toBe(docId);
    expect(filaDespues?.faltaComprobante).toBe(false);
  });

  it("crearPago con documentoId ya arranca con faltaComprobante = false", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db, 1490);
    await aplicarAnticipoTest(db, tramiteId, 3_000_000n);
    const docId = await crearDocumentoTest(db, tramiteId, CategoriaDocumento.COMPROBANTE_BANCARIO);

    const pago = await crearPago({
      tramiteId,
      concepto: "Pago con comprobante desde el inicio",
      valor: 1_000_000n,
      canalPago: CanalPago.PSE,
      usuarioId: db.userId,
      documentoId: docId,
    });

    const libro = await getLibroPagos(tramiteId);
    const fila = libro.pagos.find((p) => p.id === pago.id);
    expect(fila?.faltaComprobante).toBe(false);
  });

  // ─── Pago multi-DO (caso Karina/Occidente) ────────────────────────────────

  it("listarFacturasElegiblesMultiDO agrupa por DO y marca tieneAnticipoAplicado", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario MultiDO Listado");
    const tramiteConAnticipo = await crearTramiteTest(db, 1440);
    const tramiteSinAnticipo = await crearTramiteTest(db, 1441);
    await aplicarAnticipoTest(db, tramiteConAnticipo, 3_000_000n);

    await crearFacturaProveedorTest(db, tramiteConAnticipo, "FP-MULTI-040", 500_000n, beneficiarioId);
    await crearFacturaProveedorTest(db, tramiteSinAnticipo, "FP-MULTI-041", 700_000n, beneficiarioId);

    const facturas = await listarFacturasElegiblesMultiDO(beneficiarioId);
    expect(facturas).toHaveLength(2);
    const fConAnticipo = facturas.find((f) => f.tramiteId === tramiteConAnticipo);
    const fSinAnticipo = facturas.find((f) => f.tramiteId === tramiteSinAnticipo);
    expect(fConAnticipo?.tieneAnticipoAplicado).toBe(true);
    expect(fSinAnticipo?.tieneAnticipoAplicado).toBe(false);
  });

  it("crearPagoMultiDO feliz: 2 DOs, 3 facturas — un PagoTramite por DO, costo PRIMER_DO una sola vez", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario MultiDO Feliz");

    const tramiteA = await crearTramiteTest(db, 1400);
    const tramiteB = await crearTramiteTest(db, 1401);
    await aplicarAnticipoTest(db, tramiteA, 10_000_000n);
    await aplicarAnticipoTest(db, tramiteB, 10_000_000n);

    const fp1 = await crearFacturaProveedorTest(db, tramiteA, "FP-MULTI-001", 1_000_000n, beneficiarioId);
    const fp2 = await crearFacturaProveedorTest(db, tramiteA, "FP-MULTI-002", 500_000n, beneficiarioId);
    const fp3 = await crearFacturaProveedorTest(db, tramiteB, "FP-MULTI-003", 2_000_000n, beneficiarioId);

    const documentoId = await crearDocumentoTest(db, tramiteA, CategoriaDocumento.COMPROBANTE_BANCARIO);

    const resultado = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: fp3, monto: 2_000_000n },
        { facturaProveedorId: fp1, monto: 1_000_000n },
        { facturaProveedorId: fp2, monto: 500_000n },
      ],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      documentoId,
      // Explícito (D-1): el costo va entero al primer DO (por consecutivo) que puede absorberlo.
      costoAsumidoPor: "PRIMER_DO",
      usuarioId: db.userId,
    });

    expect(resultado.repetido).toBe(false);
    expect(resultado.costoAsumidoPor).toBe("PRIMER_DO");
    expect(resultado.pagos).toHaveLength(2); // uno por DO, no uno por factura
    // Ordenados por consecutivo aunque la selección llegó en otro orden.
    expect(resultado.pagos.map((p) => p.tramiteId)).toEqual([tramiteA, tramiteB]);
    for (const pago of resultado.pagos) {
      expect(pago.grupoPagoId).toBe(resultado.grupoPagoId);
      expect(pago.documentoId).toBe(documentoId);
    }

    const pagoA = resultado.pagos.find((p) => p.tramiteId === tramiteA)!;
    const pagoB = resultado.pagos.find((p) => p.tramiteId === tramiteB)!;
    expect(pagoA.valor).toBe(1_500_000n); // 1.000.000 + 500.000
    expect(pagoB.valor).toBe(2_000_000n);

    // TRANSF_BANCOLOMBIA = 3.900 UNA sola vez, en el primer DO por consecutivo.
    expect(pagoA.costoBancario).toBe(3_900n);
    expect(pagoB.costoBancario).toBe(0n);
    const cabecera = await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: resultado.grupoPagoId } });
    expect(cabecera.costoBancario).toBe(3_900n);
    expect(cabecera.totalAplicado).toBe(3_500_000n);
    expect(cabecera.costoAsumidoPor).toBe("PRIMER_DO");

    // Las 3 facturas quedan PAGADA
    for (const fpId of [fp1, fp2, fp3]) {
      const fp = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
      expect(fp?.estado).toBe(EstadoFacturaProveedor.PAGADA);
    }

    // Los pivots PagoTramiteFactura quedan vinculados con su monto (2 en A, 1 en B)
    const vinculosA = await prisma.pagoTramiteFactura.findMany({ where: { pagoId: pagoA.id } });
    const vinculosB = await prisma.pagoTramiteFactura.findMany({ where: { pagoId: pagoB.id } });
    expect(vinculosA.map((v) => v.monto).reduce((s, m) => s + m, 0n)).toBe(1_500_000n);
    expect(vinculosA).toHaveLength(2);
    expect(vinculosB.map((v) => v.monto)).toEqual([2_000_000n]);

    // El libro de pagos de cada DO expone los "otros DOs" del grupo (badge multi-DO)
    const libroA = await getLibroPagos(tramiteA);
    const filaA = libroA.pagos.find((p) => p.id === pagoA.id)!;
    expect(filaA.grupoOtrosDOs).toHaveLength(1);
    expect(filaA.grupoOtrosDOs[0].tramiteId).toBe(tramiteB);
    expect(filaA.esBloque).toBe(true);
    expect(filaA.editableDinero).toBe(false);
    expect(filaA.grupo?.costoAsumidoPor).toBe("PRIMER_DO");
  });

  it("crearPagoMultiDO rechaza el grupo completo si UN DO no tiene anticipo aplicado (indica cuál)", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario MultiDO SinAnticipo");

    const tramiteConAnticipo = await crearTramiteTest(db, 1410);
    const tramiteSinAnticipo = await crearTramiteTest(db, 1411);
    await aplicarAnticipoTest(db, tramiteConAnticipo, 5_000_000n);
    // tramiteSinAnticipo: sin AplicacionAnticipo a propósito

    const fp1 = await crearFacturaProveedorTest(db, tramiteConAnticipo, "FP-MULTI-010", 1_000_000n, beneficiarioId);
    const fp2 = await crearFacturaProveedorTest(db, tramiteSinAnticipo, "FP-MULTI-011", 1_000_000n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, tramiteConAnticipo);

    let capturado: unknown;
    try {
      await crearPagoMultiDO({
        beneficiarioId,
        facturas: [
          { facturaProveedorId: fp1, monto: 1_000_000n },
          { facturaProveedorId: fp2, monto: 1_000_000n },
        ],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      });
    } catch (error) {
      capturado = error;
    }

    expect(capturado).toBeInstanceOf(SinAnticipoAplicadoMultiDOError);
    expect((capturado as SinAnticipoAplicadoMultiDOError).tramiteId).toBe(tramiteSinAnticipo);
    expect((capturado as SinAnticipoAplicadoMultiDOError).codigo).toBe("SIN_ANTICIPO");

    // Transacción completa revertida: NINGÚN pago ni cabecera en ninguno de los 2 DOs
    const pagosA = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteConAnticipo } });
    const pagosB = await prisma.pagoTramite.findMany({ where: { tramiteId: tramiteSinAnticipo } });
    expect(pagosA).toHaveLength(0);
    expect(pagosB).toHaveLength(0);
    expect(await prisma.pagoGrupo.count({ where: { beneficiarioId } })).toBe(0);

    // Las facturas siguen REGISTRADA
    const fp1Final = await prisma.facturaProveedor.findUnique({ where: { id: fp1 } });
    expect(fp1Final?.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
  });

  it("crearPagoMultiDO sin comprobante bancario se rechaza (COMPROBANTE_OBLIGATORIO, D-5)", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario MultiDO SinComprobante");
    const tramiteId = await crearTramiteTest(db, 1420);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);
    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-MULTI-020", 1_000_000n, beneficiarioId);

    await expect(
      crearPagoMultiDO({
        beneficiarioId,
        facturas: [{ facturaProveedorId: fpId, monto: 1_000_000n }],
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow("Adjunta el comprobante del banco.");

    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(0);
  });

  it("crearPagoMultiDO: abono deja la factura PARCIAL con su saldo; el siguiente bloque paga el resto; un tercero se rechaza", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario MultiDO Parcial");
    const tramiteId = await crearTramiteTest(db, 1430);
    await aplicarAnticipoTest(db, tramiteId, 5_000_000n);
    const documentoId = await crearDocumentoTest(db, tramiteId);

    const fpId = await crearFacturaProveedorTest(db, tramiteId, "FP-MULTI-030", 2_000_000n, beneficiarioId);

    const resultado = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [{ facturaProveedorId: fpId, monto: 1_200_000n }], // abono: 1.2M de 2M
      canalPago: CanalPago.PSE,
      documentoId,
      usuarioId: db.userId,
    });

    expect(resultado.pagos).toHaveLength(1);
    expect(resultado.pagos[0].valor).toBe(1_200_000n);
    expect(resultado.pagos[0].grupoPagoId).toBe(resultado.grupoPagoId);

    // CxP v2: queda Abonada con saldo 800.000 y sigue en el pendiente.
    let fp = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: fpId } });
    expect(fp.estado).toBe(EstadoFacturaProveedor.PARCIAL);
    const elegibles = await listarFacturasElegiblesMultiDO(beneficiarioId);
    expect(elegibles).toHaveLength(1);
    expect(elegibles[0].saldo).toBe(800_000n);
    expect(elegibles[0].aplicado).toBe(1_200_000n);

    // Más que el saldo → rechazo exacto.
    await expect(
      crearPagoMultiDO({
        beneficiarioId,
        facturas: [{ facturaProveedorId: fpId, monto: 800_001n }],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(MontoExcedeSaldoError);

    await crearPagoMultiDO({
      beneficiarioId,
      facturas: [{ facturaProveedorId: fpId, monto: 800_000n }],
      canalPago: CanalPago.PSE,
      documentoId,
      usuarioId: db.userId,
    });
    fp = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: fpId } });
    expect(fp.estado).toBe(EstadoFacturaProveedor.PAGADA);
    expect(await listarFacturasElegiblesMultiDO(beneficiarioId)).toHaveLength(0);

    await expect(
      crearPagoMultiDO({
        beneficiarioId,
        facturas: [{ facturaProveedorId: fpId, monto: 1n }],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(/ya está pagada/);
  });

  // ─── Costo bancario del bloque (D-1, R8) ──────────────────────────────────

  it("D-1: cliente con factura_conceptos_iva → ningún DO absorbe el costo: lo asume Galcomex (PagoTramite en 0, costo en la cabecera y en /pagos una vez)", async (ctx) => {
    const db = ensureDb(ctx);
    const clienteIva = await prisma.cliente.create({
      data: { nombre: "Cliente Conceptos IVA", nit: `${TEST_PREFIX}-iva-${runId}`, tipo: TipoCliente.PROPIO },
    });
    await prisma.empresaCapacidad.create({
      data: { empresaId: clienteIva.id, codigo: "factura_conceptos_iva", habilitado: true },
    });
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario D1 Galcomex");
    const a = await crearTramiteTest(db, 1550, clienteIva.id);
    const b = await crearTramiteTest(db, 1551, clienteIva.id);
    await aplicarAnticipoTest(db, a, 2_000_000n);
    await aplicarAnticipoTest(db, b, 2_000_000n);
    const fa = await crearFacturaProveedorTest(db, a, "FE-D1-A", 433_361n, beneficiarioId);
    const fb = await crearFacturaProveedorTest(db, b, "FE-D1-B", 464_077n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, a);

    const r = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: fa, monto: 433_361n },
        { facturaProveedorId: fb, monto: 464_077n },
      ],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      documentoId,
      usuarioId: db.userId,
    });
    expect(r.costoAsumidoPor).toBe("GALCOMEX");
    expect(r.costoBancario).toBe(3_900n);
    expect(r.pagos.map((p) => p.costoBancario)).toEqual([0n, 0n]);
    const cabecera = await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: r.grupoPagoId } });
    expect(cabecera.costoAsumidoPor).toBe("GALCOMEX");
    expect(cabecera.costoBancario).toBe(3_900n);

    const global = await listarPagosGlobal({ beneficiarioId });
    expect(global.costosAsumidosGalcomex).toBe(3_900n);
    expect(global.costosBancarios).toBe(3_900n); // una sola vez, aunque sean 2 pagos
    expect(global.resumenProveedor?.pendiente).toBe(0n);
    expect(global.resumenProveedor?.pagado).toBe(897_438n);
  });

  it("D-1: PRORRATEADO reparte al peso entre los DOs que pueden absorberlo (1.244 / 1.332 / 1.324 = 3.900)", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario D1 Prorrateo");
    const t1 = await crearTramiteTest(db, 1560);
    const t2 = await crearTramiteTest(db, 1561);
    const t3 = await crearTramiteTest(db, 1562);
    for (const t of [t1, t2, t3]) await aplicarAnticipoTest(db, t, 1_000_000n);
    const f1 = await crearFacturaProveedorTest(db, t1, "FE-PR-1", 433_361n, beneficiarioId);
    const f2 = await crearFacturaProveedorTest(db, t2, "FE-PR-2", 464_077n, beneficiarioId);
    const f3 = await crearFacturaProveedorTest(db, t3, "FE-PR-3", 461_377n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, t1);

    const r = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: f1, monto: 433_361n },
        { facturaProveedorId: f2, monto: 464_077n },
        { facturaProveedorId: f3, monto: 461_377n },
      ],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      costoAsumidoPor: "PRORRATEADO",
      documentoId,
      usuarioId: db.userId,
    });
    expect(r.costoAsumidoPor).toBe("PRORRATEADO");
    expect(r.pagos.map((p) => p.costoBancario)).toEqual([1_244n, 1_332n, 1_324n]);
    expect(r.pagos.reduce((s, p) => s + p.costoBancario, 0n)).toBe(3_900n);
  });

  it("D-1: por defecto el costo salta el DO ya FACTURADO y va al siguiente, con aviso COSTO_NO_COBRABLE", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario D1 Facturado");
    const t1 = await crearTramiteTest(db, 1570);
    const t2 = await crearTramiteTest(db, 1571);
    await aplicarAnticipoTest(db, t1, 1_000_000n);
    await aplicarAnticipoTest(db, t2, 1_000_000n);
    await prisma.borradorFactura.create({
      data: {
        tramiteId: t1,
        comision: 0n,
        ivaComision: 0n,
        impuesto4x1000: 0n,
        costosBancarios: 0n,
        totalAnticipo: 0n,
        totalPagos: 0n,
        totalFactura: 0n,
        estado: "FACTURADO",
        numFacturaSiigo: "BAQ-99999",
      },
    });
    const f1 = await crearFacturaProveedorTest(db, t1, "FE-FA-1", 100_000n, beneficiarioId);
    const f2 = await crearFacturaProveedorTest(db, t2, "FE-FA-2", 200_000n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, t1);

    const r = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: f1, monto: 100_000n },
        { facturaProveedorId: f2, monto: 200_000n },
      ],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      documentoId,
      usuarioId: db.userId,
    });
    expect(r.costoAsumidoPor).toBe("PRIMER_DO");
    expect(r.pagos.map((p) => p.costoBancario)).toEqual([0n, 3_900n]);
    const aviso = r.advertencias.find((a) => a.codigo === "COSTO_NO_COBRABLE");
    expect(aviso?.mensaje).toMatch(/ya tiene la factura de venta facturada: este costo ya no se le puede cobrar/);
  });
  // ─── Asesoría (NO SE COBRA) en el bloque y en el libro ────────────────────

  it("D-1 + asesoría: el costo del bloque salta el DO de solo asesoría y va al primer DO con algo cobrable; el libro no baja el saldo del cliente por la asesoría", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario Asesoría Bloque");
    const tAsesoria = await crearTramiteTest(db, 1590);
    const tTransporte = await crearTramiteTest(db, 1591);
    await aplicarAnticipoTest(db, tAsesoria, 1_000_000n);
    await aplicarAnticipoTest(db, tTransporte, 2_000_000n);

    const fAsesoria = await crearFacturaProveedorTest(db, tAsesoria, "S-ASE-1", 300_000n, beneficiarioId);
    await prisma.facturaProveedor.update({ where: { id: fAsesoria }, data: { repercutible: false } });
    const fTransporte = await crearFacturaProveedorTest(db, tTransporte, "T-ASE-1", 1_000_000n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, tAsesoria);

    const r = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: fAsesoria, monto: 300_000n },
        { facturaProveedorId: fTransporte, monto: 1_000_000n },
      ],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      documentoId,
      usuarioId: db.userId,
    });
    // Antes: PRIMER_DO dejaba los 3.900 en el DO de solo asesoría, cuyo borrador
    // no los cobra (pago sin parte cobrable) → nadie los pagaba.
    expect(r.costoAsumidoPor).toBe("PRIMER_DO");
    expect(r.pagos.map((p) => p.tramiteId)).toEqual([tAsesoria, tTransporte]);
    expect(r.pagos.map((p) => p.costoBancario)).toEqual([0n, 3_900n]);

    // Libro del DO de asesoría: el pago se ve, pero lo asume Galcomex.
    const libroAsesoria = await getLibroPagos(tAsesoria);
    expect(libroAsesoria.totalPagos).toBe(300_000n);
    expect(libroAsesoria.totalNoCobrable).toBe(300_000n);
    expect(libroAsesoria.totalPagosCobrables).toBe(0n);
    expect(libroAsesoria.pagos[0].noCobrable).toBe(300_000n);
    expect(libroAsesoria.saldoFinal).toBe(1_000_000n); // el anticipo del cliente no se toca

    // Libro del DO de transporte: todo se cobra, con su costo.
    const libroTransporte = await getLibroPagos(tTransporte);
    expect(libroTransporte.totalNoCobrable).toBe(0n);
    expect(libroTransporte.costosBancariosCobrables).toBe(3_900n);
    expect(libroTransporte.saldoFinal).toBe(1_000_000n);
  });

  it("saldo del DO con asesoría: el libro, el contexto de CxP y el aviso del bloque dicen lo mismo (hallazgo 3 de la revisión final)", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario Saldo Asesoría");
    const t = await crearTramiteTest(db, 1592);
    await aplicarAnticipoTest(db, t, 1_000_000n);
    const fAsesoria = await crearFacturaProveedorTest(db, t, "S-SAL-1", 300_000n, beneficiarioId);
    await prisma.facturaProveedor.update({ where: { id: fAsesoria }, data: { repercutible: false } });
    const fTransporte = await crearFacturaProveedorTest(db, t, "T-SAL-1", 900_000n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, t);

    // 1. Galcomex paga la asesoría (300.000): no toca el anticipo del cliente.
    await crearPagoMultiDO({
      beneficiarioId,
      facturas: [{ facturaProveedorId: fAsesoria, monto: 300_000n }],
      canalPago: CanalPago.PSE,
      documentoId,
      usuarioId: db.userId,
    });
    const libro = await getLibroPagos(t);
    const contexto = (await cargarContextoDos(prisma, [t])).get(t);
    expect(libro.saldoFinal).toBe(1_000_000n);
    // Antes: 700.000 (anticipo − todos los pagos, asesoría incluida).
    expect(contexto?.saldoTramite).toBe(libro.saldoFinal);
    expect(contexto?.totalPagos).toBe(0n);

    // 2. Transporte de 900.000: al cliente le quedan 100.000, sin aviso de
    //    «anticipo insuficiente» (antes: 700.000 − 900.000 < 0).
    const r = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [{ facturaProveedorId: fTransporte, monto: 900_000n }],
      canalPago: CanalPago.PSE,
      documentoId,
      usuarioId: db.userId,
    });
    expect(r.advertencias.filter((a) => a.codigo === "ANTICIPO_INSUFICIENTE")).toEqual([]);
    const libroDespues = await getLibroPagos(t);
    const contextoDespues = (await cargarContextoDos(prisma, [t])).get(t);
    expect(libroDespues.saldoFinal).toBe(100_000n);
    expect(contextoDespues?.saldoTramite).toBe(libroDespues.saldoFinal);
  });

  it("PRORRATEADO pesa solo lo que se cobra: DO1 (T 100.000 + asesoría 900.000) y DO2 (T 1.000.000), costo 7.300 → 664 / 6.636 (hallazgo 7)", async (ctx) => {
    const db = ensureDb(ctx);
    const beneficiarioId = await crearBeneficiarioTest("Beneficiario Prorrateo Asesoría");
    const t1 = await crearTramiteTest(db, 1593);
    const t2 = await crearTramiteTest(db, 1594);
    await aplicarAnticipoTest(db, t1, 2_000_000n);
    await aplicarAnticipoTest(db, t2, 2_000_000n);
    const fT1 = await crearFacturaProveedorTest(db, t1, "T-PRA-1", 100_000n, beneficiarioId);
    const fA1 = await crearFacturaProveedorTest(db, t1, "S-PRA-1", 900_000n, beneficiarioId);
    await prisma.facturaProveedor.update({ where: { id: fA1 }, data: { repercutible: false } });
    const fT2 = await crearFacturaProveedorTest(db, t2, "T-PRA-2", 1_000_000n, beneficiarioId);
    const documentoId = await crearDocumentoTest(db, t1);

    const r = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: fT1, monto: 100_000n },
        { facturaProveedorId: fA1, monto: 900_000n },
        { facturaProveedorId: fT2, monto: 1_000_000n },
      ],
      canalPago: CanalPago.TRANSF_OTROS_BANCOS,
      costoAsumidoPor: "PRORRATEADO",
      documentoId,
      usuarioId: db.userId,
    });
    expect(r.costoAsumidoPor).toBe("PRORRATEADO");
    expect(r.pagos.map((p) => p.tramiteId)).toEqual([t1, t2]);
    // Antes: 3.650 / 3.650 (el DO1 pesaba 1.000.000 con la asesoría).
    expect(r.pagos.map((p) => p.costoBancario)).toEqual([664n, 6_636n]);
  });
});
