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

import {
  AgenciaAduanas,
  CanalPago,
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

import { prisma } from "@/lib/db/prisma";
import { generarBorrador, transicionarBorrador } from "../service";

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

async function crearTramiteTest(db: Fixture): Promise<string> {
  tramiteCounter++;
  const numero = tramiteCounter;
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
): Promise<void> {
  const costoRecaudo = await prisma.matrizRecaudo
    .findUnique({ where: { tipoRecaudo }, select: { costoFijo: true } })
    .then((r) => r?.costoFijo ?? 0n);

  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: db.clienteId,
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
    await prisma.tarifario.create({
      data: {
        empresaId: empresa.id,
        nombre: "Tarifa OTROS vitest",
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
          ],
        },
      },
    });
    const otro = await crearOtroTest(empresa.id, db.userId);

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
    await prisma.tarifario.create({
      data: {
        empresaId: empresa.id,
        nombre: "Tarifa OTROS con pendiente vitest",
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
    // El OTRO no trae numContenedores: el ítem "Por contenedor" queda pendiente.
    const otro = await crearOtroTest(empresa.id, db.userId);

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
});
