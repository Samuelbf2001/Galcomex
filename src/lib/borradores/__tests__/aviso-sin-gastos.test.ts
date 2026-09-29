/**
 * M2 (revisión INTEG-B, 29-sep-2026) — aviso NO bloqueante «este trámite no
 * tiene gastos pagados por Galcomex registrados» en la revisión del borrador.
 *
 * Parte pura (sin BD) + parte contra Postgres local (`DATABASE_URL`; sin BD se
 * omite). TEST_PREFIX único: "vitest-m2-aviso".
 */
import "dotenv/config";

import { CanalPago, Ciudad, EstadoBorrador, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AVISO_SIN_GASTOS_GALCOMEX,
  avisoSinGastosSinRomper,
  avisosSinGastosDeTramites,
  borradorEnRevision,
  debeAvisarSinGastos,
} from "@/lib/borradores/aviso-sin-gastos";
import { cargarBorradoresDeTramite, cargarBorradoresEnLote } from "@/lib/borradores/consulta";
import { generarBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { createTramite } from "@/lib/tramites/service";

describe("debeAvisarSinGastos (puro)", () => {
  const base = { empresaConAnticipos: false, pagos: 0, facturasCobrables: 0, esLiquidacionDeComisiones: false };

  it("empresa sin anticipos, sin pagos y sin facturas que cobrar → avisa", () => {
    expect(debeAvisarSinGastos(base)).toBe(true);
  });

  it("con anticipos, con pagos, con facturas cobrables o de comisiones → no avisa", () => {
    expect(debeAvisarSinGastos({ ...base, empresaConAnticipos: true })).toBe(false);
    expect(debeAvisarSinGastos({ ...base, pagos: 1 })).toBe(false);
    expect(debeAvisarSinGastos({ ...base, facturasCobrables: 2 })).toBe(false);
    expect(debeAvisarSinGastos({ ...base, esLiquidacionDeComisiones: true })).toBe(false);
  });

  it("solo se muestra mientras el borrador sigue por revisar", () => {
    expect(borradorEnRevision(EstadoBorrador.BORRADOR)).toBe(true);
    expect(borradorEnRevision(EstadoBorrador.EN_REVISION)).toBe(true);
    expect(borradorEnRevision(EstadoBorrador.APROBADO)).toBe(false);
    expect(borradorEnRevision(EstadoBorrador.FACTURADO)).toBe(false);
  });

  it("el texto es el acordado", () => {
    expect(AVISO_SIN_GASTOS_GALCOMEX).toBe(
      "Este trámite no tiene gastos pagados por Galcomex registrados. Si Galcomex pagó algo por el cliente (VUCE, puerto, transporte), regístralo antes de aprobar.",
    );
  });
});

const TEST_PREFIX = "vitest-m2-aviso";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CODIGO_CONCEPTO = `VITEST_M2_${Date.now().toString(36).toUpperCase()}`;
const ANIO = 3031;
const CONCEPTOS_IVA = { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 15 } };

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";
let creditoId = ""; // sin anticipos_cliente (como Polyrec ZF / Sesderma / CW / Coldex)
let anticiposId = ""; // con anticipos_cliente (como Litoplas)
let contador = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);
  const usuarios = await prisma.user.findMany({ where: { email: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const usuarioIds = usuarios.map((u) => u.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: usuarioIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...borradorIds, ...clienteIds] } },
      ],
    },
  });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.comisionTramite.deleteMany({
    where: { OR: [{ tramiteId: { in: tramiteIds } }, { empresaId: { in: clienteIds } }] },
  });
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: CODIGO_CONCEPTO } });
  await prisma.user.deleteMany({ where: { id: { in: usuarioIds } } });
}

/** Un «Otros» (servicio suelto, se factura por valor) de la empresa; manda a facturar y genera su borrador si se pide. */
async function otros(clienteId: string) {
  contador += 1;
  return createTramite({
    tipoTramiteCodigo: "OTRO",
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId,
    creadoPorId: adminId,
    referenciaExterna: `M2 ${TEST_PREFIX} ${contador}`,
    valorServicio: 500_000n,
    conceptoServicioCodigo: CODIGO_CONCEPTO,
  });
}

async function borradorDe(tramiteId: string) {
  await prisma.tramiteDO.update({ where: { id: tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
  return generarBorrador({ tramiteId, usuarioId: adminId });
}

async function factura(tramiteId: string, repercutible: boolean) {
  contador += 1;
  await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "PROVEEDOR VITEST M2",
      numFactura: `M2-${contador}-${RUN_ID.slice(-6)}`,
      concepto: "Transporte",
      valor: 100_000n,
      fecha: new Date(`${ANIO}-01-10T00:00:00Z`),
      repercutible,
      subidaPorId: adminId,
    },
  });
}

describe("M2 — aviso «sin gastos de Galcomex» (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const admin = await prisma.user.create({
        data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest M2", rol: Rol.ADMIN },
      });
      adminId = admin.id;
      await prisma.conceptoVenta.create({
        data: { codigo: CODIGO_CONCEPTO, nombre: "SERVICIO VITEST M2", aplicaIva: true, activo: true },
      });
      const credito = await prisma.cliente.create({
        data: {
          nombre: "CREDITO VITEST M2",
          nit: `${RUN_ID}-credito`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: [{ codigo: "anticipos_cliente", habilitado: false }, CONCEPTOS_IVA] },
        },
      });
      creditoId = credito.id;
      const conAnticipos = await prisma.cliente.create({
        data: {
          nombre: "ANTICIPOS VITEST M2",
          nit: `${RUN_ID}-anticipos`,
          tipo: TipoCliente.PROPIO,
          capacidades: { create: [{ codigo: "anticipos_cliente", habilitado: true }, CONCEPTOS_IVA] },
        },
      });
      anticiposId = conAnticipos.id;
      dbConnected = true;
    } catch (error) {
      dbUnavailableReason = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (dbConnected) await limpiar();
    await prisma.$disconnect();
  });

  it("empresa sin anticipos, DO sin pagos ni facturas de proveedor → aviso; con una factura que se cobra, o con un pago, ya no", async (ctx) => {
    ensureDb(ctx);
    const t = await otros(creditoId);
    expect(await avisoSinGastosSinRomper(t.id)).toBe(AVISO_SIN_GASTOS_GALCOMEX);

    // Una factura de proveedor que NO se le cobra al cliente no cuenta como gasto por reembolsar.
    await factura(t.id, false);
    expect(await avisoSinGastosSinRomper(t.id)).toBe(AVISO_SIN_GASTOS_GALCOMEX);

    // Con una que sí se cobra, ya no.
    await factura(t.id, true);
    expect(await avisoSinGastosSinRomper(t.id)).toBeNull();

    // Un pago registrado también lo quita.
    const t2 = await otros(creditoId);
    expect(await avisoSinGastosSinRomper(t2.id)).toBe(AVISO_SIN_GASTOS_GALCOMEX);
    await prisma.pagoTramite.create({
      data: { tramiteId: t2.id, concepto: "Pago VUCE", valor: 150_000n, canalPago: CanalPago.PSE, costoBancario: 0n },
    });
    expect(await avisoSinGastosSinRomper(t2.id)).toBeNull();
  });

  it("empresa con anticipos (Litoplas, clientes de Lucho): sin pagos NO avisa (ahí el DO vacío ya se frena al solicitar)", async (ctx) => {
    ensureDb(ctx);
    const t = await otros(anticiposId);
    expect(await avisoSinGastosSinRomper(t.id)).toBeNull();
  });

  it("el «Otros» de una liquidación de comisiones no avisa (es una comisión, sin gastos por reembolsar)", async (ctx) => {
    ensureDb(ctx);
    const liquidacion = await otros(creditoId);
    const origen = await otros(anticiposId);
    expect(await avisoSinGastosSinRomper(liquidacion.id)).toBe(AVISO_SIN_GASTOS_GALCOMEX);
    await prisma.comisionTramite.create({
      data: {
        tramiteId: origen.id,
        empresaId: creditoId,
        unidades: 3,
        registradoPorId: adminId,
        liquidacionTramiteId: liquidacion.id,
        liquidadaEn: new Date(),
      },
    });
    expect(await avisoSinGastosSinRomper(liquidacion.id)).toBeNull();
  });

  it("varios DOs a la vez: solo aparecen los que aplican; los ids que no existen se ignoran", async (ctx) => {
    ensureDb(ctx);
    const sinGastos = await otros(creditoId);
    const conGastos = await otros(creditoId);
    await factura(conGastos.id, true);
    const conAnticipos = await otros(anticiposId);

    const avisos = await avisosSinGastosDeTramites([sinGastos.id, conGastos.id, conAnticipos.id, "no-existe", sinGastos.id]);
    expect([...avisos.keys()]).toEqual([sinGastos.id]);
    expect(avisos.get(sinGastos.id)).toBe(AVISO_SIN_GASTOS_GALCOMEX);
    expect((await avisosSinGastosDeTramites([])).size).toBe(0);
  });

  it("la revisión (individual y por lote) trae el aviso mientras el borrador está en BORRADOR/EN_REVISION, sin cambiar los montos; APROBADO ya no", async (ctx) => {
    ensureDb(ctx);
    const t = await otros(creditoId);
    const borrador = await borradorDe(t.id);
    // Los montos son los de siempre: 500.000 + IVA 95.000 − ReteIVA 15 % (14.250).
    expect(borrador.totalFacturaLineas).toBe(580_750n);

    const usuario = { id: adminId, rol: "ADMIN" };
    const individual = await cargarBorradoresDeTramite(t.id, usuario);
    expect(individual.borradores).toHaveLength(1);
    expect(individual.borradores[0]!.avisoSinGastos).toBe(AVISO_SIN_GASTOS_GALCOMEX);

    const lote = await cargarBorradoresEnLote([t.id], usuario);
    const delLote = lote[t.id];
    expect(delLote && "borradores" in delLote ? delLote.borradores[0]!.avisoSinGastos : "sin lote").toBe(
      AVISO_SIN_GASTOS_GALCOMEX,
    );

    // Registrar un gasto cobrable quita el aviso (se evaluó y ya no aplica: null, no ausente).
    await factura(t.id, true);
    const despues = await cargarBorradoresDeTramite(t.id, usuario);
    expect(despues.borradores[0]!.avisoSinGastos).toBeNull();
    await prisma.facturaProveedor.deleteMany({ where: { tramiteId: t.id } });

    // Aprobado: ya no es "antes de aprobar", el campo no viene.
    await prisma.borradorFactura.update({ where: { id: borrador.id }, data: { estado: EstadoBorrador.APROBADO } });
    const aprobado = await cargarBorradoresDeTramite(t.id, usuario);
    expect(aprobado.borradores[0]!.avisoSinGastos).toBeUndefined();
  });
});
