/**
 * Tests de integración — Borradores de factura (A1-T8)
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * Si la BD no está disponible, todos los tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-borradores"
 * Año de datos de prueba: 3003 (no colisiona con datos reales)
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AgenciaAduanas,
  CanalPago,
  CategoriaDocumento,
  Ciudad,
  DisparadorTarifa,
  EstadoBorrador,
  EstadoTarifario,
  EstadoTramite,
  Rol,
  TipoCalculoTarifa,
  TipoCliente,
  TipoRecaudo,
  UnidadTarifa,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crearFichaConEmpresaTest } from "@/lib/beneficiarios/__tests__/fixtures";
import { calcularSaldoLMInterno } from "@/lib/calculations/cruce-lm";
import { calcularBorrador } from "@/lib/calculations/motor-factura";
import { prisma } from "@/lib/db/prisma";
import { getParametrosSistema } from "@/lib/parametros/service";
import { crearPagoMultiDO } from "@/lib/pagos/service";
import { cargarBorradoresDeTramite } from "../consulta";
import {
  actualizarComisionInternaLM,
  generarBorrador,
  transicionarBorrador,
} from "../service";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEST_PREFIX = "vitest-borradores";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3003;

// ─── Fixture ─────────────────────────────────────────────────────────────────

type Fixture = {
  clienteId: string;
  userId: string;
  userRevisorId: string;
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

  // Facturas → líneas revisión → borradores
  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
        { entidadId: { in: borradorIds } },
      ],
    },
  });

  await prisma.factura.deleteMany({
    where: { borradorId: { in: borradorIds } },
  });
  await prisma.lineaRevision.deleteMany({
    where: { borradorId: { in: borradorIds } },
  });
  await prisma.borradorFactura.deleteMany({
    where: { id: { in: borradorIds } },
  });
  await prisma.aplicacionAnticipo.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.pagoTramite.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  // Cabeceras de los pagos en bloque (CxP v2) de los usuarios de test.
  await prisma.pagoGrupo.deleteMany({
    where: { OR: [{ creadoPorId: { in: userIds } }, { concepto: { startsWith: TEST_PREFIX } }] },
  });
  // Los enlaces pago↔factura y pago↔beneficiario caen en cascada con el pago;
  // luego las facturas y los beneficiarios del pago en bloque.
  await prisma.facturaProveedor.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.beneficiario.deleteMany({
    where: { OR: [{ nit: { startsWith: TEST_PREFIX } }, { empresaId: { in: clienteIds } }] },
  });

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
  // Tarifario/TarifaItem (test de "tarifa OTROS vigente con líneas"): los
  // ítems se van en cascada al borrar el tarifario.
  await prisma.tarifario.deleteMany({
    where: { empresaId: { in: clienteIds } },
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
      email: `${TEST_PREFIX}-admin-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Borradores Admin",
      rol: Rol.ADMIN,
    },
  });

  const userRevisor = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-revisor-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Borradores Revisor",
      rol: Rol.REVISOR,
    },
  });

  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Vitest Borradores",
      nit: `${TEST_PREFIX}-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });

  return { clienteId: cliente.id, userId: user.id, userRevisorId: userRevisor.id };
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ?? "BD local Postgres no disponible para tests de borradores",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }

  return fixture;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tramiteCounter = 0;

async function crearTramiteTest(db: Fixture, clienteId = db.clienteId): Promise<string> {
  tramiteCounter++;
  const numero = tramiteCounter;
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
      // generarBorrador exige un trámite en estado facturable (ENVIADO_A_FACTURAR+)
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
    },
  });

  return tramite.id;
}

async function crearAnticipoYAplicar(
  db: Fixture,
  tramiteId: string,
  monto: bigint,
  tipoRecaudo: TipoRecaudo,
  clienteId = db.clienteId,
): Promise<void> {
  const costoRecaudo = await prisma.matrizRecaudo
    .findUnique({ where: { tipoRecaudo }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);

  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId,
      monto,
      fecha: new Date(`${stateYear}-01-10`),
      tipoRecaudo,
      costoRecaudo,
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

async function crearPagoTest(
  tramiteId: string,
  valor: bigint,
  canal: CanalPago,
  orden: number,
): Promise<void> {
  const costoBancario = await prisma.matrizPago
    .findUnique({ where: { canalPago: canal }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);

  await prisma.pagoTramite.create({
    data: {
      tramiteId,
      concepto: `Pago test ${valor}`,
      valor,
      canalPago: canal,
      costoBancario,
      orden,
    },
  });
}

// ─── Helpers de flujo corto (servicio suelto: OTRO) ──────────────────────────

let empresaFlujoCortoCounter = 0;

/**
 * Empresa para los tests de flujo corto. `conceptosIva`/`tarifarioPropio`
 * controlan las dos capacidades que gobiernan `resolverFacturableFlujoCorto`
 * (`lib/tramites/flujo-corto.ts`): sin `factura_conceptos_iva` no se puede
 * facturar un servicio suelto (C1); `tarifario_propio` habilita la rama de
 * tarifa vigente con líneas.
 */
async function crearEmpresaFlujoCorto(
  nombre: string,
  opciones: { tipo?: TipoCliente; conceptosIva?: boolean; tarifarioPropio?: boolean } = {},
) {
  empresaFlujoCortoCounter++;
  const capacidades = [
    ...(opciones.conceptosIva !== false
      ? [
          {
            codigo: "factura_conceptos_iva",
            habilitado: true,
            config: { reteIvaPorcentaje: 15, observacionNoRetenciones: true },
          },
        ]
      : []),
    ...(opciones.tarifarioPropio ? [{ codigo: "tarifario_propio", habilitado: true }] : []),
  ];

  return prisma.cliente.create({
    data: {
      nombre,
      nit: `${TEST_PREFIX}-flujo-corto-${runId}-${empresaFlujoCortoCounter}`,
      tipo: opciones.tipo ?? TipoCliente.PROPIO,
      capacidades: capacidades.length > 0 ? { create: capacidades } : undefined,
    },
  });
}

/** DO de tipo OTRO (flujo corto) listo para `generarBorrador`. */
async function crearOtroTest(
  clienteId: string,
  usuarioId: string,
  extra: Partial<{
    valorServicio: bigint | null;
    conceptoServicioCodigo: string | null;
    referenciaExterna: string | null;
    estado: EstadoTramite;
  }> = {},
) {
  tramiteCounter++;
  return prisma.tramiteDO.create({
    data: {
      consecutivo: `OTR${String(stateYear).slice(-2)}-${String(tramiteCounter).padStart(4, "0")}-${runId}`,
      tipoTramiteCodigo: "OTRO",
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero: tramiteCounter,
      clienteId,
      creadoPorId: usuarioId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado: extra.estado ?? EstadoTramite.ENVIADO_A_FACTURAR,
      valorServicio: extra.valorServicio,
      conceptoServicioCodigo: extra.conceptoServicioCodigo,
      referenciaExterna: extra.referenciaExterna,
    },
  });
}

async function costoMatrizPago(canal: CanalPago): Promise<bigint> {
  return prisma.matrizPago
    .findUnique({ where: { canalPago: canal }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);
}

async function costoMatrizRecaudo(tipoRecaudo: TipoRecaudo): Promise<bigint> {
  return prisma.matrizRecaudo
    .findUnique({ where: { tipoRecaudo }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);
}

/** Factura de proveedor del trámite. `repercutible=false` = «NO SE COBRA» (asesoría). */
async function crearFacturaProveedorTest(
  db: Fixture,
  tramiteId: string,
  numFactura: string,
  valor: bigint,
  repercutible: boolean,
  beneficiarioId: string | null = null,
): Promise<string> {
  const factura = await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "ASCINTER VITEST",
      beneficiarioId,
      numFactura: `${numFactura}-${runId}`,
      valor,
      fecha: new Date(`${stateYear}-01-15`),
      repercutible,
      subidaPorId: db.userId,
    },
  });
  return factura.id;
}

/** Beneficiario (proveedor) del pago en bloque; nit prefijado para la limpieza. */
async function crearBeneficiarioTest(): Promise<string> {
  // Fase 3: la ficha lleva su empresa solo-proveedora (mismo NIT prefijado, así
  // `cleanupTestData` borra las fichas primero y las empresas después).
  const b = await crearFichaConEmpresaTest({
    nombre: "ASCINTER VITEST",
    nit: `${TEST_PREFIX}-${runId}-${Math.random().toString(36).slice(2)}`,
  });
  return b.id;
}

/** Comprobante bancario del pago en bloque (CxP v2 lo exige salvo histórico). */
async function crearComprobanteTest(db: Fixture, tramiteId: string): Promise<string> {
  const doc = await prisma.documento.create({
    data: {
      tramiteId,
      categoria: CategoriaDocumento.COMPROBANTE_BANCARIO,
      nombreArchivo: "comprobante-vitest.pdf",
      storageKey: `vitest/${runId}/${Math.random().toString(36).slice(2)}.pdf`,
      mimeType: "application/pdf",
      tamanoBytes: 1024,
      subidoPorId: db.userId,
    },
  });
  return doc.id;
}

/**
 * Pago en bloque escrito directo en la BD, como lo deja la migración de CxP v2
 * para un bloque anterior a v2: cabecera PagoGrupo, UN PagoTramite del DO y
 * sus enlaces con el `monto` que la migración pudo asignar (0 = no pudo), más
 * las filas de auditoría del bloque (`antes.montoPagadoEnGrupo`) que se pasen
 * (p. ej. las de un bloque eliminado y rehecho, o las de antes de editarlo).
 */
async function crearBloqueHeredadoTest(
  db: Fixture,
  tramiteId: string,
  beneficiarioId: string,
  canal: CanalPago,
  orden: number,
  enlaces: { facturaId: string; monto: bigint }[],
  auditoria: { facturaId: string; montoPagadoEnGrupo: bigint }[],
  valor: bigint,
): Promise<string> {
  const grupoPagoId = randomUUID();
  const costoBancario = await costoMatrizPago(canal);
  await prisma.pagoGrupo.create({
    data: {
      id: grupoPagoId,
      beneficiarioId,
      concepto: `${TEST_PREFIX} bloque heredado`,
      canalPago: canal,
      totalAplicado: valor,
      costoBancario,
      costoAsumidoPor: "PRIMER_DO",
      creadoPorId: db.userId,
    },
  });
  const pago = await prisma.pagoTramite.create({
    data: {
      tramiteId,
      concepto: `Pago en bloque heredado ${valor}`,
      grupoPagoId,
      valor,
      canalPago: canal,
      costoBancario,
      orden,
      facturasProveedor: { create: enlaces },
    },
  });
  for (const a of auditoria) {
    await prisma.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: a.facturaId,
        accion: "UPDATE_ESTADO",
        usuarioId: db.userId,
        tramiteId,
        antes: { estado: "REGISTRADA", montoPagadoEnGrupo: a.montoPagadoEnGrupo.toString() },
        despues: { estado: "PAGADA" },
      },
    });
  }
  return pago.id;
}

/**
 * Pago del libro enlazado a facturas de proveedor. Sin `montos`, cada enlace
 * queda con monto 0: un enlace HEREDADO que la migración de CxP v2 no pudo
 * repartir (el caso en que todavía se usa la auditoría del pago en bloque).
 * Con `montos` (mismo orden que `facturaIds`) es un enlace de CxP v2.
 */
async function crearPagoEnlazadoTest(
  tramiteId: string,
  valor: bigint,
  canal: CanalPago,
  orden: number,
  facturaIds: string[],
  montos?: bigint[],
): Promise<void> {
  await prisma.pagoTramite.create({
    data: {
      tramiteId,
      concepto: `Pago enlazado test ${valor}`,
      valor,
      canalPago: canal,
      costoBancario: await costoMatrizPago(canal),
      orden,
      facturasProveedor: {
        create: facturaIds.map((facturaId, i) => ({ facturaId, monto: montos?.[i] ?? 0n })),
      },
    },
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("borradores service con Postgres local", () => {
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

  // ─── TEST DORADO END-TO-END ───────────────────────────────────────────────
  // Los pagos ya no se auto-generan como líneas del borrador: el usuario las crea
  // manualmente en el editor asignando producto Siigo a cada una. El borrador nace
  // únicamente con las dos líneas fijas (4x1000 y costos bancarios) que sí tienen
  // producto Siigo configurado en parámetros del sistema. Por eso totalFactura,
  // saldoAFavorCliente y conteo de líneas se calculan ahora sin incluir los pagos.
  it(
    "TEST DORADO: DO.BUN26-0026 → impuesto4x1000=180.904, costosBancarios=17.550 (tolerancia 0). Los pagos NO se auto-generan como líneas: el usuario los crea manualmente con producto Siigo.",
    async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);

      // Anticipo: 45.226.000, canal OTRO (costoFijo=1.950)
      await crearAnticipoYAplicar(db, tramiteId, 45_226_000n, TipoRecaudo.BANCOLOMBIA);

      // 7 pagos según el Excel DO.BUN26-0026
      // Canales asignados para que costosBancarios = 17.550:
      //   PSE         = 0       (pagos 2, 3, 4, 5 → 0+0+0+0=0)
      //   TRANSF      = 3.900   (pagos 1, 6, 7 → 3×3.900 = 11.700... insuficiente)
      // Para llegar a 17.550 con los canales disponibles:
      //   Pago 1: 1.000.000    PSE           = 0
      //   Pago 2: 2.011.341    PSE           = 0
      //   Pago 3: 30.854.000   PSE           = 0
      //   Pago 4: 2.216.233    PSE           = 0
      //   Pago 5: 760.283      BANCOLOMBIA_TRANSFERENCIA = 3.900
      //   Pago 6: 175.787      BANCOLOMBIA_TRANSFERENCIA = 3.900
      //   Pago 7: 3.500.000    BANCOLOMBIA_TRANSFERENCIA = 3.900
      //   Anticipo: OTRO = 1.950
      //   Total costos bancarios = 1.950 (anticipo) + 3×3.900 (pagos) = 1.950 + 11.700 = 13.650
      //   Hmm... necesitamos 17.550 en total.
      //   17.550 - 1.950 (anticipo OTRO) = 15.600 de pagos
      //   15.600 / 3.900 = 4 pagos BANCOLOMBIA_TRANSFERENCIA
      //   Entonces: 4 pagos TRANSF + anticipo OTRO = 4×3.900 + 1.950 = 17.550 ✓
      const pagosConfig: Array<{ valor: bigint; canal: CanalPago }> = [
        { valor: 1_000_000n,  canal: CanalPago.PSE },
        { valor: 2_011_341n,  canal: CanalPago.PSE },
        { valor: 30_854_000n, canal: CanalPago.PSE },
        { valor: 2_216_233n,  canal: CanalPago.TRANSF_BANCOLOMBIA },
        { valor: 760_283n,    canal: CanalPago.TRANSF_BANCOLOMBIA },
        { valor: 175_787n,    canal: CanalPago.TRANSF_BANCOLOMBIA },
        { valor: 3_500_000n,  canal: CanalPago.TRANSF_BANCOLOMBIA },
      ];

      for (let i = 0; i < pagosConfig.length; i++) {
        await crearPagoTest(tramiteId, pagosConfig[i]!.valor, pagosConfig[i]!.canal, i + 1);
      }

      // Generar borrador con overrides del caso dorado
      const borrador = await generarBorrador({
        tramiteId,
        comision: 200_000n,
        ivaComision: 76_000n,   // Override manual del Excel (no es 19% × 200.000)
        montoLM: 875_944n,
        usuarioId: db.userId,
      });

      // ── CRITERIOS BLOQUEANTES (tolerancia 0) ──────────────────────────────
      // Los pagos no se siembran como líneas; el usuario los crea manualmente
      // asignándoles producto Siigo. El borrador nace con las CUATRO líneas
      // fijas: COMISION, IVA_COMISION, COSTOS_BANCARIOS, IMPUESTO_4X1000.
      //
      // totalFactura = Σ(4 líneas fijas) − retenciones
      //              = 17.550 + 180.904 + 200.000 + 76.000 − 0
      //              = 474.454
      // saldoFinal   = totalAnticipo − totalFactura = 45.226.000 − 474.454 = 44.751.546
      // saldoAFavorCliente = saldoFinal − montoLM   = 44.751.546 − 875.944 = 43.875.602
      expect(borrador.totalFactura, "totalFactura").toBe(474_454n);
      expect(borrador.saldoAFavorCliente, "saldoAFavorCliente").toBe(43_875_602n);
      expect(borrador.saldoAFavorLM, "saldoAFavorLM").toBe(875_944n);
      expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(180_904n);
      expect(borrador.costosBancarios, "costosBancarios").toBe(17_550n);

      // Verificar estado inicial
      expect(borrador.estado).toBe(EstadoBorrador.BORRADOR);

      // Las 4 líneas fijas: COSTOS_BANCARIOS, COMISION, IVA_COMISION, IMPUESTO_4X1000.
      expect(borrador.lineasRevision).toHaveLength(4);
      const tiposFijos = borrador.lineasRevision
        .map((l) => l.tipoFija)
        .filter((t): t is string => t !== null)
        .sort();
      expect(tiposFijos).toEqual(
        ["COMISION", "COSTOS_BANCARIOS", "IMPUESTO_4X1000", "IVA_COMISION"],
      );
    },
  );

  // ─── TEST DORADO: flujo corto (OTRO), decisión de Ernesto 26-sep-2026 ────
  // Un OTRO (Plan Vallejo, sellos…) se abre sin tarifa y se factura por el
  // valor escrito a mano — nunca por tarifario. Caso real BAQ-18222: OTR con
  // valor 350.000, concepto PLAN_VALLEJO, empresa CONCEPTOS_IVA con ReteIVA
  // 15 % → IVA 66.500, ReteIVA 9.975, total 406.525 (tolerancia 0).
  it(
    "TEST DORADO flujo corto: OTR valorServicio=350.000 (PLAN_VALLEJO) → total 406.525 (BAQ-18222)",
    async (ctx) => {
      const db = ensureDb(ctx);

      // `update` fija el nombre siempre (no solo en `create`): así el test es
      // determinista sin importar si el seed real ya sembró el concepto con
      // otra mayúscula/minúscula.
      await prisma.conceptoVenta.upsert({
        where: { codigo: "PLAN_VALLEJO" },
        update: { nombre: "Programa Plan Vallejo", aplicaIva: true },
        create: { codigo: "PLAN_VALLEJO", nombre: "Programa Plan Vallejo", aplicaIva: true },
      });

      const empresa = await crearEmpresaFlujoCorto("Cliente Vitest Flujo Corto Dorado");
      const otro = await crearOtroTest(empresa.id, db.userId, {
        valorServicio: 350_000n,
        conceptoServicioCodigo: "PLAN_VALLEJO",
        referenciaExterna: "Firma programa Plan Vallejo 2026",
      });

      const borrador = await generarBorrador({ tramiteId: otro.id, usuarioId: db.userId });

      expect(borrador.formatoFactura, "formatoFactura").toBe("CONCEPTOS_IVA");
      expect(borrador.totalFactura, "totalFactura").toBe(406_525n);
      expect(borrador.saldoACargoCliente, "saldoACargoCliente").toBe(406_525n);
      expect(borrador.saldoAFavorCliente, "saldoAFavorCliente").toBe(0n);
      // Una sola línea operacional (el servicio) + la línea derivada de IVA;
      // sin terceros no hay 4x1000. El nombre de la línea es el del concepto
      // de venta (docs/CATALOGOS.md §1) — `referenciaExterna` NO llega ahí.
      const lineasOperacion = borrador.lineasRevision.filter((l) => l.tipoFija === null);
      expect(lineasOperacion).toHaveLength(1);
      expect(lineasOperacion[0]?.valor).toBe(350_000n);
      expect(lineasOperacion[0]?.concepto).toBe("Programa Plan Vallejo");
      const ivaLinea = borrador.lineasRevision.find((l) => l.tipoFija === "IVA_COMISION");
      expect(ivaLinea?.valor, "IVA").toBe(66_500n);
      expect(borrador.retenciones, "ReteIVA").toBe(9_975n);
      // M1: referenciaExterna sale en las observaciones ("SERVICIO: …").
      expect(borrador.comentariosCabecera).toContain(
        "SERVICIO: Firma programa Plan Vallejo 2026",
      );
    },
  );

  // ─── C1 · sin formato CONCEPTOS_IVA no se factura un servicio suelto ─────
  it("generarBorrador: PROPIO sin «Factura con conceptos e IVA» → 422 FORMATO_CONCEPTOS_REQUERIDO", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Comision", {
      conceptosIva: false,
    });
    const otro = await crearOtroTest(empresa.id, db.userId, {
      valorServicio: 350_000n,
      conceptoServicioCodigo: "PLAN_VALLEJO",
    });

    await expect(generarBorrador({ tramiteId: otro.id, usuarioId: db.userId })).rejects.toMatchObject(
      { name: "FormatoConceptosRequeridoError", status: 422, codigo: "FORMATO_CONCEPTOS_REQUERIDO" },
    );
  });

  it("generarBorrador: SOCIO_LM (factura por comisión) → 422 FORMATO_CONCEPTOS_REQUERIDO", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC SocioLM", {
      tipo: TipoCliente.SOCIO_LM,
      conceptosIva: false,
    });
    const otro = await crearOtroTest(empresa.id, db.userId, {
      valorServicio: 350_000n,
      conceptoServicioCodigo: "PLAN_VALLEJO",
    });

    await expect(generarBorrador({ tramiteId: otro.id, usuarioId: db.userId })).rejects.toMatchObject(
      { name: "FormatoConceptosRequeridoError", status: 422, codigo: "FORMATO_CONCEPTOS_REQUERIDO" },
    );
  });

  // ─── A1 · sin valor/concepto ni tarifa con líneas no se factura "en blanco" ──
  it("generarBorrador: sin valorServicio/concepto y sin tarifa vigente → 422 VALOR_SERVICIO_REQUERIDO (nunca comisionDefault)", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Sin Valor");
    const otro = await crearOtroTest(empresa.id, db.userId);

    await expect(generarBorrador({ tramiteId: otro.id, usuarioId: db.userId })).rejects.toMatchObject(
      { name: "ValorServicioRequeridoError", status: 422, codigo: "VALOR_SERVICIO_REQUERIDO" },
    );
  });

  it("generarBorrador: valorServicio SIN conceptoServicioCodigo → 422 VALOR_SERVICIO_REQUERIDO", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Sin Concepto");
    const otro = await crearOtroTest(empresa.id, db.userId, { valorServicio: 350_000n });

    await expect(generarBorrador({ tramiteId: otro.id, usuarioId: db.userId })).rejects.toMatchObject(
      { name: "ValorServicioRequeridoError", status: 422, codigo: "VALOR_SERVICIO_REQUERIDO" },
    );
  });

  // ─── Con tarifa OTROS vigente y CON líneas, y sin valor a mano: usa la tarifa ──
  it("generarBorrador: sin valorServicio pero con tarifa OTROS vigente (con líneas) → usa la tarifa", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Tarifa", {
      tarifarioPropio: true,
    });
    // B2 (Diseño B): la tarifa de «Otros» declara su servicio y el DO busca por el suyo.
    await prisma.conceptoVenta.upsert({
      where: { codigo: "PLAN_VALLEJO" },
      update: { nombre: "Programa Plan Vallejo", aplicaIva: true },
      create: { codigo: "PLAN_VALLEJO", nombre: "Programa Plan Vallejo", aplicaIva: true },
    });
    await prisma.tarifario.create({
      data: {
        empresaId: empresa.id,
        nombre: "Tarifa OTROS vitest",
        alcance: "OTROS",
        conceptoServicioCodigo: "PLAN_VALLEJO",
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
          ],
        },
      },
    });
    const otro = await crearOtroTest(empresa.id, db.userId, { conceptoServicioCodigo: "PLAN_VALLEJO" });

    const borrador = await generarBorrador({ tramiteId: otro.id, usuarioId: db.userId });

    expect(borrador.formatoFactura).toBe("CONCEPTOS_IVA");
    const lineasOperacion = borrador.lineasRevision.filter((l) => l.tipoFija === null);
    expect(lineasOperacion).toHaveLength(1);
    expect(lineasOperacion[0]?.valor).toBe(80_000n);
    expect(borrador.comision, "comisionTarifa").toBe(80_000n);
  });

  // ─── M-N1 · un ítem pendiente nunca se factura "de menos" en silencio ────
  it("generarBorrador: tarifa OTROS con un ítem pendiente (por contenedor, sin datos) → 422 TarifaIncompletaError", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Pendiente", {
      tarifarioPropio: true,
    });
    // B2 (Diseño B): la tarifa de «Otros» declara su servicio y el DO busca por el suyo.
    await prisma.conceptoVenta.upsert({
      where: { codigo: "PLAN_VALLEJO" },
      update: { nombre: "Programa Plan Vallejo", aplicaIva: true },
      create: { codigo: "PLAN_VALLEJO", nombre: "Programa Plan Vallejo", aplicaIva: true },
    });
    await prisma.tarifario.create({
      data: {
        empresaId: empresa.id,
        nombre: "Tarifa OTROS con pendiente vitest",
        alcance: "OTROS",
        conceptoServicioCodigo: "PLAN_VALLEJO",
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
    // El OTRO no trae numContenedores: el ítem "Por contenedor" queda pendiente.
    const otro = await crearOtroTest(empresa.id, db.userId, { conceptoServicioCodigo: "PLAN_VALLEJO" });

    await expect(
      generarBorrador({ tramiteId: otro.id, usuarioId: db.userId }),
    ).rejects.toMatchObject({ name: "TarifaIncompletaError", status: 422 });

    // Nunca se crea un borrador con solo la línea que sí se pudo calcular
    // (80.000): facturar de menos en silencio es peor que no facturar.
    const borradores = await prisma.borradorFactura.findMany({ where: { tramiteId: otro.id } });
    expect(borradores).toHaveLength(0);
  });

  // ─── B-N1 · el modal manual de Facturación no puede saltarse la regla ───
  it("generarBorrador: con valor+concepto ignora la comisión del modal manual (usa el valor a mano)", async (ctx) => {
    const db = ensureDb(ctx);
    await prisma.conceptoVenta.upsert({
      where: { codigo: "PLAN_VALLEJO" },
      update: { nombre: "Programa Plan Vallejo", aplicaIva: true },
      create: { codigo: "PLAN_VALLEJO", nombre: "Programa Plan Vallejo", aplicaIva: true },
    });
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Modal Manual");
    const otro = await crearOtroTest(empresa.id, db.userId, {
      valorServicio: 350_000n,
      conceptoServicioCodigo: "PLAN_VALLEJO",
    });

    // Simula el modal manual "Generar borrador" de Facturación, que precarga
    // comisión = 150.000.
    const borrador = await generarBorrador({
      tramiteId: otro.id,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // El valor a mano manda: 350.000, no los 150.000 del modal.
    expect(borrador.comision).toBe(350_000n);
    const lineasOperacion = borrador.lineasRevision.filter((l) => l.tipoFija === null);
    expect(lineasOperacion).toHaveLength(1);
    expect(lineasOperacion[0]?.valor).toBe(350_000n);
  });

  it("generarBorrador: sin valor/concepto ni tarifa, la comisión del modal manual tampoco factura (422)", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresaFlujoCorto("Cliente Vitest FC Modal Sin Valor");
    const otro = await crearOtroTest(empresa.id, db.userId);

    await expect(
      generarBorrador({ tramiteId: otro.id, comision: 150_000n, usuarioId: db.userId }),
    ).rejects.toMatchObject({ name: "ValorServicioRequeridoError", status: 422 });
  });

  // ─── No se puede facturar un borrador no aprobado ────────────────────────
  it("no se puede facturar un borrador no aprobado → 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 10_000_000n, TipoRecaudo.BANCOLOMBIA);

    // Crear borrador en estado BORRADOR
    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    expect(borrador.estado).toBe(EstadoBorrador.BORRADOR);

    // Intentar facturar directamente desde BORRADOR → debe fallar con 422
    const result = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.userId,
      numFacturaSiigo: "BAQ-99999",
      fechaFactura: new Date(`${stateYear}-06-01`),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  // ─── No se puede facturar un borrador en EN_REVISION ─────────────────────
  it("no se puede facturar un borrador en EN_REVISION → 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 10_000_000n, TipoRecaudo.BANCOLOMBIA);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // Avanzar a EN_REVISION
    const r1 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });
    expect(r1.ok).toBe(true);

    // Intentar facturar desde EN_REVISION → debe fallar
    const result = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.userId,
      numFacturaSiigo: "BAQ-99998",
      fechaFactura: new Date(`${stateYear}-06-01`),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  // ─── Ciclo completo BORRADOR → EN_REVISION → APROBADO → FACTURADO ────────
  it("ciclo completo: BORRADOR → EN_REVISION → APROBADO → FACTURADO + Factura creada", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 20_000_000n, TipoRecaudo.BANCOLOMBIA);
    await crearPagoTest(tramiteId, 15_000_000n, CanalPago.PSE, 1);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      montoLM: 100_000n,
      usuarioId: db.userId,
    });

    // BORRADOR → EN_REVISION
    const r1 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });
    expect(r1.ok).toBe(true);

    // EN_REVISION → APROBADO
    const r2 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userRevisorId,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.borrador?.estado).toBe(EstadoBorrador.APROBADO);
      expect(r2.borrador?.aprobadoPorId).toBe(db.userRevisorId);
      expect(r2.borrador?.fechaAprobacion).toBeTruthy();
    }

    // APROBADO → FACTURADO
    const numSiigo = `TEST-${runId.slice(-8)}`;
    const r3 = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.userId,
      numFacturaSiigo: numSiigo,
      fechaFactura: new Date(`${stateYear}-06-15`),
    });
    expect(r3.ok).toBe(true);
    if (r3.ok) {
      expect(r3.borrador?.estado).toBe(EstadoBorrador.FACTURADO);
      expect(r3.borrador?.numFacturaSiigo).toBe(numSiigo);
      // Verificar que se creó el registro Factura
      expect(r3.borrador?.factura).toBeTruthy();
    }
  });

  // ─── Snapshot inmutable al aprobar ───────────────────────────────────────
  it("snapshot inmutable: tras aprobar, snapshotCalculo queda guardado en BD", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 15_000_000n, TipoRecaudo.BANCOLOMBIA);
    await crearPagoTest(tramiteId, 10_000_000n, CanalPago.PSE, 1);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // Avanzar a EN_REVISION
    await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.userId,
    });

    // Aprobar
    await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userRevisorId,
    });

    // Verificar que el snapshot quedó guardado en BD
    const borradorDB = await prisma.borradorFactura.findUnique({
      where: { id: borrador.id },
      select: { snapshotCalculo: true, estado: true },
    });

    expect(borradorDB?.estado).toBe(EstadoBorrador.APROBADO);
    expect(borradorDB?.snapshotCalculo).not.toBeNull();
    expect(typeof borradorDB?.snapshotCalculo).toBe("object");

    // El snapshot debe contener los valores calculados como strings (BigInt serializado)
    const snap = borradorDB?.snapshotCalculo as Record<string, unknown>;
    expect(snap).toHaveProperty("totalFactura");
    expect(snap).toHaveProperty("saldoAFavorCliente");
    expect(snap).toHaveProperty("comision");
  });

  // ─── Transición inválida ─────────────────────────────────────────────────
  it("transición inválida (BORRADOR → APROBADO) retorna 422", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 5_000_000n, TipoRecaudo.BANCOLOMBIA);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 150_000n,
      usuarioId: db.userId,
    });

    // Intentar saltar EN_REVISION → debe fallar
    const result = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.userId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  // ─── Asesoría no repercutible (caso Ascinter) ────────────────────────────
  // Lo que Galcomex paga por facturas que NO se le cobran al cliente
  // (repercutible=false) no entra en totalPagos, costos bancarios ni 4x1000.
  it("asesoría no repercutible no suma en totalPagos, costos ni 4x1000", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA);

    // A: pago suelto (sin factura) → cuenta completo.
    await crearPagoTest(tramiteId, 2_000_000n, CanalPago.TRANSF_BANCOLOMBIA, 1);
    // B: pago de solo asesoría → fuera (valor y costo bancario).
    const s1 = await crearFacturaProveedorTest(db, tramiteId, "S1", 500_000n, false);
    await crearPagoEnlazadoTest(tramiteId, 500_000n, CanalPago.TRANSF_BANCOLOMBIA, 2, [s1]);
    // C: pago en bloque transporte 1.000.000 (se cobra) + asesoría 300.000 (no).
    const t2 = await crearFacturaProveedorTest(db, tramiteId, "T2", 1_000_000n, true);
    const s2 = await crearFacturaProveedorTest(db, tramiteId, "S2", 300_000n, false);
    await crearPagoEnlazadoTest(tramiteId, 1_300_000n, CanalPago.TRANSF_BANCOLOMBIA, 3, [t2, s2]);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      ivaComision: 38_000n,
      usuarioId: db.userId,
    });

    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoTransf = await costoMatrizPago(CanalPago.TRANSF_BANCOLOMBIA);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 3_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [
        { valor: 2_000_000n, costoBancario: costoTransf },
        { valor: 1_000_000n, costoBancario: costoTransf },
      ],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });

    expect(borrador.totalPagos, "totalPagos").toBe(3_000_000n);
    expect(borrador.costosBancarios, "costosBancarios").toBe(costoRecaudo + 2n * costoTransf);
    expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);
    if (params.tasa4x1000 === 400n && costoRecaudo === 1_950n && costoTransf === 3_900n) {
      expect(borrador.impuesto4x1000).toBe(12_991n);
    }
    const lineaCostos = borrador.lineasRevision.find((l) => l.tipoFija === "COSTOS_BANCARIOS");
    expect(lineaCostos?.valor, "línea COSTOS_BANCARIOS").toBe(costoRecaudo + 2n * costoTransf);
    const linea4x1000 = borrador.lineasRevision.find((l) => l.tipoFija === "IMPUESTO_4X1000");
    expect(linea4x1000?.valor, "línea IMPUESTO_4X1000").toBe(esperado.impuesto4x1000);
  });

  // ─── Abono parcial y sobrante: primero lo no cobrable, y rastro para el revisor ─
  it("abono parcial en bloque, pago con sobrante y dos transferencias que juntas pagan de más un transporte: se cobra solo lo que no es asesoría, el sobrante lo asume Galcomex y el revisor los ve marcados", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA);

    // Bloque: 500.000 al transporte (factura 1.000.000) + asesoría 300.000 = 800.000.
    const t = await crearFacturaProveedorTest(db, tramiteId, "T-AB", 1_000_000n, true);
    const s = await crearFacturaProveedorTest(db, tramiteId, "S-AB", 300_000n, false);
    await crearPagoEnlazadoTest(tramiteId, 800_000n, CanalPago.TRANSF_BANCOLOMBIA, 1, [t, s]);
    // Resto del transporte, enlazado solo al transporte: se cobra completo.
    await crearPagoEnlazadoTest(tramiteId, 500_000n, CanalPago.TRANSF_BANCOLOMBIA, 2, [t]);
    // Transferencia de 1.200.000 enlazada solo a una asesoría de 200.000: nada
    // se le cobra al cliente (ni el sobrante ni la transferencia); queda
    // marcada por si el sobrante era transporte sin factura enlazada.
    const s2 = await crearFacturaProveedorTest(db, tramiteId, "S2-AB", 200_000n, false);
    await crearPagoEnlazadoTest(tramiteId, 1_200_000n, CanalPago.TRANSF_BANCOLOMBIA, 3, [s2]);
    // Otro transporte de 1.000.000 pagado con dos transferencias de 650.000
    // enlazadas solo a él: ninguna pasa sola de la factura, pero entre las dos
    // se le cobran 1.300.000 al cliente (¿300.000 de asesoría sin enlazar?).
    // Se cobran completas (ningún total cambia) y las dos quedan marcadas.
    const t3 = await crearFacturaProveedorTest(db, tramiteId, "T3-AB", 1_000_000n, true);
    await crearPagoEnlazadoTest(tramiteId, 650_000n, CanalPago.TRANSF_BANCOLOMBIA, 4, [t3]);
    await crearPagoEnlazadoTest(tramiteId, 650_000n, CanalPago.TRANSF_BANCOLOMBIA, 5, [t3]);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      ivaComision: 38_000n,
      usuarioId: db.userId,
    });

    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoTransf = await costoMatrizPago(CanalPago.TRANSF_BANCOLOMBIA);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 3_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      // El pago de 1.200.000 (solo asesoría) no entra: ni valor ni transferencia.
      pagos: [
        { valor: 500_000n, costoBancario: costoTransf },
        { valor: 500_000n, costoBancario: costoTransf },
        { valor: 650_000n, costoBancario: costoTransf },
        { valor: 650_000n, costoBancario: costoTransf },
      ],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });

    expect(borrador.totalPagos, "totalPagos").toBe(2_300_000n);
    expect(borrador.costosBancarios, "costosBancarios").toBe(costoRecaudo + 4n * costoTransf);
    expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);
    const linea4x1000 = borrador.lineasRevision.find((l) => l.tipoFija === "IMPUESTO_4X1000");
    expect(linea4x1000?.valor, "línea IMPUESTO_4X1000").toBe(esperado.impuesto4x1000);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "BorradorFactura", entidadId: borrador.id, accion: "CREATE" },
      select: { despues: true },
    });
    const despues = audit?.despues as {
      pagosNoCobrables?: { valor: string; costoBancario: string };
      pagosPorRevisar?: Array<Record<string, unknown>>;
    };
    // 300.000 de la asesoría del bloque + 1.200.000 del pago de solo asesoría,
    // y la transferencia de ese último pago.
    expect(despues.pagosNoCobrables).toEqual({
      valor: "1500000",
      costoBancario: costoTransf.toString(),
    });
    // El pago de 500.000 enlazado solo al transporte T (1.000.000) no se marca
    // porque, sumado con los demás pagos enlazados solo a esa factura (aquí
    // ninguno), no pasa de su valor. Pagar menos que la factura NO basta para
    // descartarlo: las dos transferencias de 650.000 a T3 sí se marcan.
    expect(despues.pagosPorRevisar).toEqual([
      expect.objectContaining({
        valor: "800000",
        sumaFacturas: "1300000",
        cobrable: "500000",
        noCobrable: "300000",
        motivo: "ABONO_PARCIAL",
      }),
      expect.objectContaining({
        valor: "1200000",
        sumaFacturas: "200000",
        cobrable: "0",
        noCobrable: "1200000",
        motivo: "SOBRANTE_NO_COBRADO",
      }),
      expect.objectContaining({
        valor: "650000",
        sumaFacturas: "1000000",
        cobrable: "650000",
        noCobrable: "0",
        motivo: "SOBRANTE_COBRADO",
      }),
      expect.objectContaining({
        valor: "650000",
        sumaFacturas: "1000000",
        cobrable: "650000",
        noCobrable: "0",
        motivo: "SOBRANTE_COBRADO",
      }),
    ]);

    // Lo que ve quien revisa (GET /api/tramites/[id]/borrador): los mismos
    // pagos marcados, con BigInt. El SOCIO nunca los recibe (ver test LM).
    const { borradores } = await cargarBorradoresDeTramite(tramiteId, {
      id: db.userRevisorId,
      rol: "REVISOR",
    });
    const visto = borradores.find((b) => b.id === borrador.id);
    expect(visto?.pagosPorRevisar).toEqual([
      expect.objectContaining({ valor: 800_000n, cobrable: 500_000n, noCobrable: 300_000n }),
      expect.objectContaining({
        valor: 1_200_000n,
        sumaFacturas: 200_000n,
        cobrable: 0n,
        noCobrable: 1_200_000n,
      }),
      expect.objectContaining({ valor: 650_000n, cobrable: 650_000n, motivo: "SOBRANTE_COBRADO" }),
      expect.objectContaining({ valor: 650_000n, cobrable: 650_000n, motivo: "SOBRANTE_COBRADO" }),
    ]);
  });

  // ─── Pago en bloque real: montos de la auditoría → reparto exacto ─────────
  it("pago en bloque con la asesoría neta de retención: el borrador cobra el transporte completo y no marca nada", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA);

    const beneficiarioId = await crearBeneficiarioTest();
    const t = await crearFacturaProveedorTest(db, tramiteId, "T-BQ", 1_000_000n, true, beneficiarioId);
    const s = await crearFacturaProveedorTest(db, tramiteId, "S-BQ", 300_000n, false, beneficiarioId);
    // Transporte completo + asesoría pagada en 288.000 (neta de retención):
    // UN pago de 1.288.000 enlazado a las dos facturas. CxP v2 guarda el monto
    // de cada enlace (1.000.000 / 288.000): el reparto sale de ahí.
    const bloque = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: t, monto: 1_000_000n },
        { facturaProveedorId: s, monto: 288_000n },
      ],
      canalPago: CanalPago.PSE,
      documentoId: await crearComprobanteTest(db, tramiteId),
      usuarioId: db.userId,
    });
    expect(bloque.pagos.map((p) => p.valor)).toEqual([1_288_000n]);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      ivaComision: 38_000n,
      usuarioId: db.userId,
    });

    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoPse = await costoMatrizPago(CanalPago.PSE);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 3_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [{ valor: 1_000_000n, costoBancario: costoPse }],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });

    // Sin los montos del bloque se habrían cobrado 988.000 (1.288.000 − 300.000).
    expect(borrador.totalPagos, "totalPagos").toBe(1_000_000n);
    expect(borrador.costosBancarios, "costosBancarios").toBe(costoRecaudo + costoPse);
    expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "BorradorFactura", entidadId: borrador.id, accion: "CREATE" },
      select: { despues: true },
    });
    const despues = audit?.despues as {
      pagosNoCobrables?: { valor: string; costoBancario: string };
      pagosPorRevisar?: unknown[];
    };
    expect(despues.pagosNoCobrables).toEqual({ valor: "288000", costoBancario: "0" });
    expect(despues.pagosPorRevisar).toEqual([]);

    const { borradores } = await cargarBorradoresDeTramite(tramiteId, {
      id: db.userId,
      rol: "ADMIN",
    });
    expect(borradores.find((b) => b.id === borrador.id)?.pagosPorRevisar).toEqual([]);
  });

  // ─── SOCIO_LM: la comisión interna tampoco suma el costo de la asesoría ──
  it("SOCIO_LM: actualizarComisionInternaLM no suma el costo bancario de un pago de solo asesoría", async (ctx) => {
    const db = ensureDb(ctx);
    const clienteLM = await prisma.cliente.create({
      data: {
        nombre: "Cliente Vitest Borradores LM",
        nit: `${TEST_PREFIX}-lm-${runId}`,
        tipo: TipoCliente.SOCIO_LM,
      },
    });
    const tramiteId = await crearTramiteTest(db, clienteLM.id);
    await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA, clienteLM.id);

    await crearPagoTest(tramiteId, 2_000_000n, CanalPago.TRANSF_BANCOLOMBIA, 1);
    const s1 = await crearFacturaProveedorTest(db, tramiteId, "S1-LM", 500_000n, false);
    await crearPagoEnlazadoTest(tramiteId, 500_000n, CanalPago.TRANSF_BANCOLOMBIA, 2, [s1]);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      usuarioId: db.userId,
    });
    expect(borrador.totalPagos, "totalPagos").toBe(2_000_000n);

    const params = await getParametrosSistema();
    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoTransf = await costoMatrizPago(CanalPago.TRANSF_BANCOLOMBIA);
    const costoCanalComision = await costoMatrizPago(CanalPago.PSE);

    const r = await actualizarComisionInternaLM(
      borrador.id,
      {
        comisionInternaLM: params.comisionDefault,
        tipoRecaudoComisionInternaLM: null,
        canalPagoComisionInternaLM: CanalPago.PSE,
      },
      db.userId,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { saldoLMInterno } = calcularSaldoLMInterno({
      totalAnticipo: 3_000_000n,
      totalPagos: 2_000_000n,
      comisionInternaLM: params.comisionDefault,
      ivaComision: borrador.ivaComision,
      // Solo el costo del pago suelto: el del pago de asesoría lo asume Galcomex.
      costosBancarios: costoRecaudo + costoTransf + costoCanalComision,
      tasa4x1000: params.tasa4x1000,
    });
    expect(r.borrador?.saldoLMInterno, "saldoLMInterno").toBe(saldoLMInterno);

    // El SOCIO consulta el borrador de su trámite sin ver nada de la asesoría
    // (costo interno de Galcomex); el ADMIN sí recibe la lista, aquí vacía: el
    // pago de solo asesoría cuadra con su factura (sin marca) y, como cubre
    // toda la asesoría del trámite, el pago suelto no puede ser asesoría sin
    // enlazar (tampoco se marca).
    const vistaSocio = await cargarBorradoresDeTramite(tramiteId, { id: db.userId, rol: "SOCIO" });
    expect(vistaSocio.borradores.length).toBeGreaterThan(0);
    expect(vistaSocio.borradores.every((b) => !("pagosPorRevisar" in b))).toBe(true);
    const vistaAdmin = await cargarBorradoresDeTramite(tramiteId, { id: db.userId, rol: "ADMIN" });
    expect(vistaAdmin.borradores.map((b) => b.pagosPorRevisar)).toEqual([[]]);
  });

  // ─── Hallazgo: bloque con asesoría eliminado y rehecho (auditoría ambigua) ─
  // CxP v2 ya no deja pagarle a una factura más que su saldo; este caso solo
  // existe en bloques ANTERIORES a v2. Se escribe directo en la BD como lo dejó
  // la migración: (1) enlaces en 0 (no pudo repartir) → la heurística de la
  // auditoría; (2) enlaces con el monto que la migración sí asignó (tope en el
  // valor de la factura): en un pago MIXTO heredado ese monto es una
  // estimación (ningún enlace lo aplicó CxP v2) y no manda → el mismo trato
  // que (1).
  it("bloque heredado con la asesoría pagada de más, eliminado y rehecho igual: cobra 943.000 (nunca asesoría) y queda por revisar", async (ctx) => {
    const db = ensureDb(ctx);
    const sinMontos = await crearTramiteTest(db);
    const conMontos = await crearTramiteTest(db);
    const beneficiarioId = await crearBeneficiarioTest();
    const bloques = new Map<string, string>();

    for (const tramiteId of [sinMontos, conMontos]) {
      await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA);
      const t = await crearFacturaProveedorTest(db, tramiteId, `T-RH-${tramiteId}`, 1_000_000n, true, beneficiarioId);
      const s = await crearFacturaProveedorTest(db, tramiteId, `S-RH-${tramiteId}`, 300_000n, false, beneficiarioId);
      // Transporte 943.000 + asesoría (factura 300.000) pagada en 357.000, en un
      // bloque que se eliminó y se rehízo igual: la auditoría tiene DOS filas
      // por factura y el libro UN solo pago (ambigua).
      const auditoria = [
        { facturaId: t, montoPagadoEnGrupo: 943_000n },
        { facturaId: s, montoPagadoEnGrupo: 357_000n },
      ];
      const enlaces =
        tramiteId === sinMontos
          ? [
              { facturaId: t, monto: 0n },
              { facturaId: s, monto: 0n },
            ]
          : [
              { facturaId: t, monto: 943_000n },
              { facturaId: s, monto: 300_000n },
            ];
      bloques.set(
        tramiteId,
        await crearBloqueHeredadoTest(
          db,
          tramiteId,
          beneficiarioId,
          CanalPago.PSE,
          1,
          enlaces,
          [...auditoria, ...auditoria],
          1_300_000n,
        ),
      );
    }

    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoPse = await costoMatrizPago(CanalPago.PSE);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 3_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [{ valor: 943_000n, costoBancario: costoPse }],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });
    const leer = async (borradorId: string) => {
      const audit = await prisma.auditLog.findFirst({
        where: { entidad: "BorradorFactura", entidadId: borradorId, accion: "CREATE" },
        select: { despues: true },
      });
      return audit?.despues as {
        resultado?: { totalFactura: string; saldoFinal: string };
        pagosNoCobrables?: { valor: string; costoBancario: string };
        pagosPorRevisar?: unknown[];
      };
    };

    for (const tramiteId of [sinMontos, conMontos]) {
      const borrador = await generarBorrador({
        tramiteId,
        comision: 200_000n,
        ivaComision: 38_000n,
        usuarioId: db.userId,
      });
      // Antes: 1.000.000 (57.000 de asesoría al cliente) y sin marca.
      expect(borrador.totalPagos, "totalPagos").toBe(943_000n);
      expect(borrador.costosBancarios, "costosBancarios").toBe(costoRecaudo + costoPse);
      expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);

      const despues = await leer(borrador.id);
      // Salida del motor tal cual (el total del borrador sale de sus líneas).
      expect(despues.resultado?.totalFactura).toBe(esperado.totalFactura.toString());
      expect(despues.resultado?.saldoFinal).toBe(esperado.saldoFinal.toString());
      expect(despues.pagosNoCobrables).toEqual({ valor: "357000", costoBancario: "0" });
      const pagoId = bloques.get(tramiteId);
      expect(despues.pagosPorRevisar).toEqual([
        {
          pagoId,
          concepto: "Pago en bloque heredado 1300000",
          numSoporte: null,
          valor: "1300000",
          // La asesoría cuenta por lo que la auditoría le registra (357.000),
          // también con los montos que estimó la migración (943.000 + 300.000).
          sumaFacturas: "1357000",
          cobrable: "943000",
          noCobrable: "357000",
          motivo: "BLOQUE_SIN_MONTOS",
        },
      ]);
    }

    const { borradores } = await cargarBorradoresDeTramite(sinMontos, {
      id: db.userRevisorId,
      rol: "REVISOR",
    });
    expect(borradores[0]?.pagosPorRevisar).toEqual([
      expect.objectContaining({ cobrable: 943_000n, motivo: "BLOQUE_SIN_MONTOS" }),
    ]);
  });

  // ─── CxP v2: el monto por enlace manda sobre la auditoría ─────────────────
  it("bloque editado en v2 (enlaces T 900.000 / S 400.000, auditoría vieja T 1.000.000 / S 300.000, mismo total): cobra 900.000, no cobra 400.000 y no marca nada", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA);

    const beneficiarioId = await crearBeneficiarioTest();
    const t = await crearFacturaProveedorTest(db, tramiteId, "T-ED", 1_000_000n, true, beneficiarioId);
    const s = await crearFacturaProveedorTest(db, tramiteId, "S-ED", 400_000n, false, beneficiarioId);
    // La auditoría (una fila por factura) cuadra con el total del pago: la
    // heurística vieja la tomaría como cierta y cobraría 1.000.000.
    const pagoId = await crearBloqueHeredadoTest(
      db,
      tramiteId,
      beneficiarioId,
      CanalPago.PSE,
      1,
      [
        { facturaId: t, monto: 900_000n },
        { facturaId: s, monto: 400_000n },
      ],
      [
        { facturaId: t, montoPagadoEnGrupo: 1_000_000n },
        { facturaId: s, montoPagadoEnGrupo: 300_000n },
      ],
      1_300_000n,
    );
    // Los enlaces los aplicó CxP v2 (`aplicarSaldo` deja su fila con
    // `despues.origen`): sus montos son un dato, no una estimación.
    for (const [facturaId, monto] of [
      [t, 900_000n],
      [s, 400_000n],
    ] as const) {
      await prisma.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: facturaId,
          accion: "UPDATE_ESTADO",
          usuarioId: db.userId,
          tramiteId,
          antes: { estado: "REGISTRADA", montoPagadoEnGrupo: monto.toString() },
          despues: {
            estado: "PARCIAL",
            monto: monto.toString(),
            modo: "BLOQUE",
            origen: { tipo: "PAGO", pagoId, tramiteId },
          },
        },
      });
    }

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      ivaComision: 38_000n,
      usuarioId: db.userId,
    });

    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoPse = await costoMatrizPago(CanalPago.PSE);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 3_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [{ valor: 900_000n, costoBancario: costoPse }],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });
    expect(borrador.totalPagos, "totalPagos").toBe(900_000n);
    expect(borrador.costosBancarios, "costosBancarios").toBe(costoRecaudo + costoPse);
    expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "BorradorFactura", entidadId: borrador.id, accion: "CREATE" },
      select: { despues: true },
    });
    const despues = audit?.despues as {
      resultado?: { totalFactura: string; saldoFinal: string };
      pagosNoCobrables?: { valor: string; costoBancario: string };
      pagosPorRevisar?: unknown[];
    };
    expect(despues.resultado?.totalFactura).toBe(esperado.totalFactura.toString());
    expect(despues.pagosNoCobrables).toEqual({ valor: "400000", costoBancario: "0" });
    expect(despues.pagosPorRevisar).toEqual([]);
  });

  // ─── Migración M3 sobre un pago mixto heredado (hallazgo crítico 25-sep) ──
  // Datos anteriores a v2: un pago de 800.000 enlazado (sin monto) al
  // transporte T (1.000.000, se cobra, registrado primero) y a la asesoría A
  // (300.000, NO SE COBRA). Se corre el paso 2 de M3 tal cual está en el repo
  // (y la versión vieja, que llenaba por fecha) y luego se genera el borrador.
  it("M3 sobre un pago mixto heredado que no alcanza: la asesoría se llena primero, el cliente paga 500.000 y el pago queda ABONO_PARCIAL (también con el reparto viejo T 800.000 / A 0)", async (ctx) => {
    const db = ensureDb(ctx);
    const migracion = readFileSync(
      path.resolve(process.cwd(), "prisma/migrations/20260925100200_cxp_v2_backfill/migration.sql"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const inicio = migracion.indexOf("WITH audit AS (");
    const fin = migracion.indexOf("-- Red de seguridad");
    expect(inicio).toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(inicio);
    const paso2 = migracion.slice(inicio, fin);
    const cierreBase =
      'LEFT JOIN audit au ON au."pagoId" = ptf."pagoId" AND au."facturaId" = ptf."facturaId"\n),';
    expect(paso2.split(cierreBase)).toHaveLength(2);
    expect(paso2).toContain('ORDER BY frep, ffecha, fcreado, "facturaId"');
    /** Paso 2 de M3 limitado a los pagos de esta prueba (la BD de test es compartida). */
    const correrPaso2 = async (pagoIds: string[], sql: string) => {
      for (const id of pagoIds) expect(id).toMatch(/^[a-z0-9]+$/);
      const filtro = `WHERE ptf."pagoId" IN (${pagoIds.map((id) => `'${id}'`).join(", ")})`;
      await prisma.$executeRawUnsafe(sql.replace(cierreBase, cierreBase.replace("\n),", `\n  ${filtro}\n),`)));
    };

    const casos = [
      { nombre: "M3 del repo (asesoría primero)", sql: paso2, esperadoT: 500_000n, esperadoA: 300_000n },
      {
        nombre: "M3 vieja (por fecha)",
        sql: paso2.replace('ORDER BY frep, ffecha, fcreado, "facturaId"', 'ORDER BY ffecha, fcreado, "facturaId"'),
        esperadoT: 800_000n,
        esperadoA: 0n,
      },
    ];
    for (const caso of casos) {
      const tramiteId = await crearTramiteTest(db);
      await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA);
      const t = await crearFacturaProveedorTest(db, tramiteId, "T-M3", 1_000_000n, true);
      const a = await crearFacturaProveedorTest(db, tramiteId, "A-M3", 300_000n, false);
      await crearPagoEnlazadoTest(tramiteId, 800_000n, CanalPago.TRANSF_BANCOLOMBIA, 1, [t, a]);
      const pago = await prisma.pagoTramite.findFirstOrThrow({ where: { tramiteId }, select: { id: true } });

      await correrPaso2([pago.id], caso.sql);
      const enlaces = await prisma.pagoTramiteFactura.findMany({
        where: { pagoId: pago.id },
        select: { facturaId: true, monto: true },
      });
      const monto = (facturaId: string) => enlaces.find((e) => e.facturaId === facturaId)?.monto;
      expect(monto(t), `${caso.nombre}: monto T`).toBe(caso.esperadoT);
      expect(monto(a), `${caso.nombre}: monto A`).toBe(caso.esperadoA);

      const borrador = await generarBorrador({
        tramiteId,
        comision: 200_000n,
        ivaComision: 38_000n,
        usuarioId: db.userId,
      });
      // Nunca se le cobra asesoría: 500.000 de transporte, no 800.000.
      expect(borrador.totalPagos, `${caso.nombre}: totalPagos`).toBe(500_000n);
      const audit = await prisma.auditLog.findFirst({
        where: { entidad: "BorradorFactura", entidadId: borrador.id, accion: "CREATE" },
        select: { despues: true },
      });
      const despues = audit?.despues as {
        pagosNoCobrables?: { valor: string; costoBancario: string };
        pagosPorRevisar?: unknown[];
      };
      expect(despues.pagosNoCobrables?.valor, caso.nombre).toBe("300000");
      expect(despues.pagosPorRevisar, caso.nombre).toEqual([
        {
          pagoId: pago.id,
          concepto: "Pago enlazado test 800000",
          numSoporte: null,
          valor: "800000",
          sumaFacturas: "1300000",
          cobrable: "500000",
          noCobrable: "300000",
          motivo: "ABONO_PARCIAL",
        },
      ]);
    }
  });

  // ─── Trámite con asesoría: pagos sueltos y sobrantes cobrables se marcan ──
  it("trámite con asesoría sin enlazar: marca el pago suelto y el que paga de más su factura, sin cambiar ningún total", async (ctx) => {
    const db = ensureDb(ctx);
    const conAsesoria = await crearTramiteTest(db);
    const sinAsesoria = await crearTramiteTest(db);

    for (const tramiteId of [conAsesoria, sinAsesoria]) {
      await crearAnticipoYAplicar(db, tramiteId, 5_000_000n, TipoRecaudo.BANCOLOMBIA);
      const t = await crearFacturaProveedorTest(db, tramiteId, `T-SC-${tramiteId}`, 1_000_000n, true);
      const t2 = await crearFacturaProveedorTest(db, tramiteId, `T2-SC-${tramiteId}`, 1_000_000n, true);
      // Pago suelto, pago mayor que su factura y pago menor que su factura.
      await crearPagoTest(tramiteId, 2_000_000n, CanalPago.TRANSF_BANCOLOMBIA, 1);
      await crearPagoEnlazadoTest(tramiteId, 1_300_000n, CanalPago.TRANSF_BANCOLOMBIA, 2, [t]);
      await crearPagoEnlazadoTest(tramiteId, 800_000n, CanalPago.PSE, 3, [t2]);
    }
    // Solo el primero tiene una asesoría (sin pago enlazado).
    await crearFacturaProveedorTest(db, conAsesoria, "S-SC", 300_000n, false);

    const generar = (tramiteId: string) =>
      generarBorrador({ tramiteId, comision: 200_000n, ivaComision: 38_000n, usuarioId: db.userId });
    const borradorCon = await generar(conAsesoria);
    const borradorSin = await generar(sinAsesoria);

    // Ningún total cambia: los tres pagos se cobran completos en ambos.
    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoTransf = await costoMatrizPago(CanalPago.TRANSF_BANCOLOMBIA);
    const costoPse = await costoMatrizPago(CanalPago.PSE);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 5_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [
        { valor: 2_000_000n, costoBancario: costoTransf },
        { valor: 1_300_000n, costoBancario: costoTransf },
        { valor: 800_000n, costoBancario: costoPse },
      ],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });
    const leerAuditoria = async (borradorId: string) => {
      const audit = await prisma.auditLog.findFirst({
        where: { entidad: "BorradorFactura", entidadId: borradorId, accion: "CREATE" },
        select: { despues: true },
      });
      return audit?.despues as {
        resultado?: Record<string, string | boolean>;
        pagosNoCobrables?: { valor: string; costoBancario: string };
        pagosPorRevisar?: unknown[];
      };
    };
    for (const b of [borradorCon, borradorSin]) {
      expect(b.totalPagos, "totalPagos").toBe(4_100_000n);
      expect(b.costosBancarios, "costosBancarios").toBe(esperado.costosBancarios);
      expect(b.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);
      // Salida completa del motor idéntica (el total del borrador sale de sus líneas).
      const { resultado } = await leerAuditoria(b.id);
      expect(resultado?.totalFactura, "totalFactura").toBe(esperado.totalFactura.toString());
      expect(resultado?.saldoFinal, "saldoFinal").toBe(esperado.saldoFinal.toString());
      expect(resultado?.saldoAFavorCliente, "saldoAFavorCliente").toBe(
        esperado.saldoAFavorCliente.toString(),
      );
    }
    expect(borradorCon.totalFactura).toBe(borradorSin.totalFactura);
    expect(borradorCon.saldoAFavorCliente).toBe(borradorSin.saldoAFavorCliente);

    const auditCon = await leerAuditoria(borradorCon.id);
    expect(auditCon.pagosNoCobrables).toEqual({ valor: "0", costoBancario: "0" });
    expect(auditCon.pagosPorRevisar).toEqual([
      expect.objectContaining({
        valor: "2000000",
        sumaFacturas: "0",
        cobrable: "2000000",
        noCobrable: "0",
        motivo: "PAGO_SIN_FACTURAS",
      }),
      expect.objectContaining({
        valor: "1300000",
        sumaFacturas: "1000000",
        cobrable: "1300000",
        noCobrable: "0",
        motivo: "SOBRANTE_COBRADO",
      }),
    ]);
    // Sin asesoría en el trámite, nada que revisar (casos dorados intactos).
    expect((await leerAuditoria(borradorSin.id)).pagosPorRevisar).toEqual([]);
  });

  // ─── Asesoría cubierta: el pago suelto de naviera no es asesoría ─────────
  it("asesoría pagada exacta por su pago enlazado o compensada: el pago suelto de naviera no se marca; si queda asesoría sin cubrir, sí; ningún total cambia", async (ctx) => {
    const db = ensureDb(ctx);
    const cubierta = await crearTramiteTest(db);
    const compensada = await crearTramiteTest(db);
    const sinCubrir = await crearTramiteTest(db);

    for (const tramiteId of [cubierta, compensada, sinCubrir]) {
      await crearAnticipoYAplicar(db, tramiteId, 5_000_000n, TipoRecaudo.BANCOLOMBIA);
      // Naviera: pago suelto (sin facturas), se cobra completo.
      await crearPagoTest(tramiteId, 2_000_000n, CanalPago.TRANSF_BANCOLOMBIA, 1);
      // Transporte pagado exacto, enlazado a su factura.
      const t = await crearFacturaProveedorTest(db, tramiteId, `T-CU-${tramiteId}`, 1_000_000n, true);
      await crearPagoEnlazadoTest(tramiteId, 1_000_000n, CanalPago.TRANSF_BANCOLOMBIA, 2, [t]);
    }
    // Asesoría de 300.000 pagada exacta con un pago enlazado a su factura.
    const sCubierta = await crearFacturaProveedorTest(db, cubierta, "S-CU", 300_000n, false);
    await crearPagoEnlazadoTest(cubierta, 300_000n, CanalPago.TRANSF_BANCOLOMBIA, 3, [sCubierta]);
    // Asesoría saldada por cruce de saldos (sin pago del libro).
    const sCompensada = await crearFacturaProveedorTest(db, compensada, "S-CO", 300_000n, false);
    await prisma.facturaProveedor.update({
      where: { id: sCompensada },
      // CxP v2: el cruce guarda cuánto saldó (aquí, toda la factura).
      data: { compensacionId: `${TEST_PREFIX}-comp-${runId}`, montoCompensado: 300_000n },
    });
    // Asesoría pagada solo en parte (200.000 de 300.000): quedan 100.000 sin cubrir.
    const sParcial = await crearFacturaProveedorTest(db, sinCubrir, "S-PA", 300_000n, false);
    await crearPagoEnlazadoTest(sinCubrir, 200_000n, CanalPago.TRANSF_BANCOLOMBIA, 3, [sParcial]);

    const generar = (tramiteId: string) =>
      generarBorrador({ tramiteId, comision: 200_000n, ivaComision: 38_000n, usuarioId: db.userId });
    const borradores = [
      await generar(cubierta),
      await generar(compensada),
      await generar(sinCubrir),
    ];

    // Ningún total cambia: se cobran la naviera y el transporte; el pago de
    // asesoría no entra (ni su valor ni su transferencia).
    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoTransf = await costoMatrizPago(CanalPago.TRANSF_BANCOLOMBIA);
    const params = await getParametrosSistema();
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 5_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [
        { valor: 2_000_000n, costoBancario: costoTransf },
        { valor: 1_000_000n, costoBancario: costoTransf },
      ],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });
    const leerAuditoria = async (borradorId: string) => {
      const audit = await prisma.auditLog.findFirst({
        where: { entidad: "BorradorFactura", entidadId: borradorId, accion: "CREATE" },
        select: { despues: true },
      });
      return audit?.despues as {
        resultado?: Record<string, string | boolean>;
        pagosPorRevisar?: unknown[];
      };
    };
    for (const b of borradores) {
      expect(b.totalPagos, "totalPagos").toBe(3_000_000n);
      expect(b.costosBancarios, "costosBancarios").toBe(esperado.costosBancarios);
      expect(b.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);
      const { resultado } = await leerAuditoria(b.id);
      expect(resultado?.totalFactura, "totalFactura").toBe(esperado.totalFactura.toString());
      expect(resultado?.saldoFinal, "saldoFinal").toBe(esperado.saldoFinal.toString());
    }

    const [bCubierta, bCompensada, bSinCubrir] = borradores;
    // Antes: la naviera salía como PAGO_SIN_FACTURAS solo porque el trámite
    // tenía una factura NO SE COBRA.
    expect((await leerAuditoria(bCubierta.id)).pagosPorRevisar).toEqual([]);
    expect((await leerAuditoria(bCompensada.id)).pagosPorRevisar).toEqual([]);
    expect((await leerAuditoria(bSinCubrir.id)).pagosPorRevisar).toEqual([
      expect.objectContaining({
        valor: "2000000",
        sumaFacturas: "0",
        cobrable: "2000000",
        noCobrable: "0",
        motivo: "PAGO_SIN_FACTURAS",
      }),
    ]);

    // Lo que ve quien revisa: lo mismo.
    const vista = await cargarBorradoresDeTramite(cubierta, { id: db.userRevisorId, rol: "REVISOR" });
    expect(vista.borradores.find((b) => b.id === bCubierta.id)?.pagosPorRevisar).toEqual([]);
  });

  // ─── Bloque mixto + otra transferencia al mismo transporte ───────────────
  it("bloque que ya pagó transporte 1.000.000 + asesoría 300.000 y otra transferencia de 650.000 al transporte: las dos quedan como SOBRANTE_COBRADO, la naviera no, y ningún total cambia", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await crearAnticipoYAplicar(db, tramiteId, 5_000_000n, TipoRecaudo.BANCOLOMBIA);

    const beneficiarioId = await crearBeneficiarioTest();
    const t = await crearFacturaProveedorTest(db, tramiteId, "T-MX", 1_000_000n, true, beneficiarioId);
    const s = await crearFacturaProveedorTest(db, tramiteId, "S-MX", 300_000n, false, beneficiarioId);
    // Pago en bloque real: transporte completo + asesoría completa.
    const bloque = await crearPagoMultiDO({
      beneficiarioId,
      facturas: [
        { facturaProveedorId: t, monto: 1_000_000n },
        { facturaProveedorId: s, monto: 300_000n },
      ],
      canalPago: CanalPago.PSE,
      documentoId: await crearComprobanteTest(db, tramiteId),
      usuarioId: db.userId,
    });
    expect(bloque.pagos.map((p) => p.valor)).toEqual([1_300_000n]);
    // Otra transferencia enlazada solo al transporte (¿asesoría o un error?).
    await crearPagoEnlazadoTest(tramiteId, 650_000n, CanalPago.TRANSF_BANCOLOMBIA, 10, [t]);
    // Naviera: pago suelto. La asesoría ya la cubre el bloque → no se marca.
    await crearPagoTest(tramiteId, 2_000_000n, CanalPago.TRANSF_BANCOLOMBIA, 11);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      ivaComision: 38_000n,
      usuarioId: db.userId,
    });

    const costoRecaudo = await costoMatrizRecaudo(TipoRecaudo.BANCOLOMBIA);
    const costoPse = await costoMatrizPago(CanalPago.PSE);
    const costoTransf = await costoMatrizPago(CanalPago.TRANSF_BANCOLOMBIA);
    const params = await getParametrosSistema();
    // Del bloque se cobra el transporte (1.000.000); la transferencia y la
    // naviera, completas. Las marcas no cambian nada de esto.
    const esperado = calcularBorrador({
      totalAnticipoAplicado: 5_000_000n,
      costoRecaudoAnticipo: costoRecaudo,
      pagos: [
        { valor: 1_000_000n, costoBancario: costoPse },
        { valor: 650_000n, costoBancario: costoTransf },
        { valor: 2_000_000n, costoBancario: costoTransf },
      ],
      comision: 200_000n,
      ivaComision: 38_000n,
      tasaIva: params.tasaIva,
      tasa4x1000: params.tasa4x1000,
    });
    expect(borrador.totalPagos, "totalPagos").toBe(3_650_000n);
    expect(borrador.costosBancarios, "costosBancarios").toBe(esperado.costosBancarios);
    expect(borrador.impuesto4x1000, "impuesto4x1000").toBe(esperado.impuesto4x1000);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "BorradorFactura", entidadId: borrador.id, accion: "CREATE" },
      select: { despues: true },
    });
    const despues = audit?.despues as {
      resultado?: { totalFactura: string; saldoFinal: string };
      pagosNoCobrables?: { valor: string; costoBancario: string };
      pagosPorRevisar?: unknown[];
    };
    expect(despues.resultado?.totalFactura).toBe(esperado.totalFactura.toString());
    expect(despues.resultado?.saldoFinal).toBe(esperado.saldoFinal.toString());
    expect(despues.pagosNoCobrables).toEqual({ valor: "300000", costoBancario: "0" });
    // Al cliente se le cobran 1.000.000 del bloque + 650.000 por un transporte
    // de 1.000.000: los dos pagos quedan marcados.
    expect(despues.pagosPorRevisar).toEqual([
      expect.objectContaining({
        pagoId: bloque.pagos[0].id,
        valor: "1300000",
        sumaFacturas: "1300000",
        cobrable: "1000000",
        noCobrable: "300000",
        motivo: "SOBRANTE_COBRADO",
      }),
      expect.objectContaining({
        valor: "650000",
        sumaFacturas: "1000000",
        cobrable: "650000",
        noCobrable: "0",
        motivo: "SOBRANTE_COBRADO",
      }),
    ]);
  });

  // ─── CONCEPTOS_IVA: lo cobrado sale de las facturas, no de los pagos ─────
  it("CONCEPTOS_IVA: no guarda pagos por revisar aunque haya un abono parcial con asesoría", async (ctx) => {
    const db = ensureDb(ctx);
    const clienteIva = await prisma.cliente.create({
      data: {
        nombre: "Cliente Vitest Borradores Conceptos IVA",
        nit: `${TEST_PREFIX}-civa-${runId}`,
        tipo: TipoCliente.PROPIO,
        capacidades: { create: [{ codigo: "factura_conceptos_iva", habilitado: true }] },
      },
    });
    const tramiteId = await crearTramiteTest(db, clienteIva.id);
    await crearAnticipoYAplicar(db, tramiteId, 3_000_000n, TipoRecaudo.BANCOLOMBIA, clienteIva.id);

    const t = await crearFacturaProveedorTest(db, tramiteId, "T-CI", 1_000_000n, true);
    const s = await crearFacturaProveedorTest(db, tramiteId, "S-CI", 300_000n, false);
    // Abono parcial mixto (en COMISION saldría como ABONO_PARCIAL) y un pago suelto.
    await crearPagoEnlazadoTest(tramiteId, 800_000n, CanalPago.TRANSF_BANCOLOMBIA, 1, [t, s]);
    await crearPagoTest(tramiteId, 500_000n, CanalPago.TRANSF_BANCOLOMBIA, 2);

    const borrador = await generarBorrador({
      tramiteId,
      comision: 200_000n,
      ivaComision: 38_000n,
      usuarioId: db.userId,
    });
    expect(borrador.formatoFactura).toBe("CONCEPTOS_IVA");
    // Lo que se cobra de terceros sale de la factura repercutible, no de los pagos.
    const terceros = borrador.lineasRevision.filter((l) => l.seccion === "TERCEROS" && !l.tipoFija);
    expect(terceros.map((l) => l.valor)).toEqual([1_000_000n]);

    const audit = await prisma.auditLog.findFirst({
      where: { entidad: "BorradorFactura", entidadId: borrador.id, accion: "CREATE" },
      select: { despues: true },
    });
    const despues = audit?.despues as {
      pagosNoCobrables?: { valor: string; costoBancario: string };
      pagosPorRevisar?: unknown[];
    };
    expect(despues.pagosPorRevisar).toEqual([]);
    expect(despues.pagosNoCobrables).toEqual({ valor: "300000", costoBancario: "0" });

    const { borradores } = await cargarBorradoresDeTramite(tramiteId, {
      id: db.userId,
      rol: "ADMIN",
    });
    expect(borradores.find((b) => b.id === borrador.id)?.pagosPorRevisar).toEqual([]);
  });
});
