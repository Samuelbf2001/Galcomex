import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generarBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { ComisionYaLiquidadaError, liquidarComisiones } from "@/lib/comisiones/liquidacion";
import {
  comisionesDeEmpresa,
  comisionesDeTramite,
  registrarComisionTramite,
} from "@/lib/comisiones/service";
import {
  ServicioDeComisionesLiquidadasError,
  createTramite,
  verificarServicioFlujoCorto,
} from "@/lib/tramites/service";

/**
 * B10 (Diseño B, 29-sep-2026) — "Facturar comisiones" de LTRANS contra
 * Postgres. Casos dorados de la cartera de LTRANS (Camila, 27-ago):
 *   BAQ-18027: 15 contenedores (12 en contenedor + 3 DOs de carga suelta)
 *              → 1.350.000 + IVA 256.500 = 1.606.500 (sin ReteIVA)
 *   BAQ-18028: 17 contenedores → 1.530.000 + 290.700 = 1.820.700
 * Dinero en BigInt, tolerancia 0.
 */

const RUN = `vitest-liq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const SUFIJO = Date.now().toString(36).toUpperCase();
const CODIGO_CONCEPTO = `VITEST_LIQ_${SUFIJO}`;
const CODIGO_CONCEPTO_INACTIVO = `VITEST_LIQ_${SUFIJO}_OFF`;
const ANIO = 2096;
const SIN_REQUISITOS_DO = [
  { codigo: "do_exige_tarifa_vigente", habilitado: false },
  { codigo: "docs_bl_factura_obligatorios", habilitado: false },
];
const $ = (n: number) => BigInt(n);

type Fixture = {
  adminId: string;
  polyrecZfId: string;
  /** LTRANS "de verdad": 90.000 por contenedor, factura con conceptos e IVA, ReteIVA 0. */
  ltransId: string;
  /** Igual pero con ReteIVA 15 % (L3). */
  ltrans15Id: string;
  /** Solo para la prueba de concurrencia (cuenta sus «Otros» sin ruido). */
  ltransConcurrenteId: string;
  /** Con comisión pero SIN `factura_conceptos_iva`. */
  sinFormatoId: string;
  /** Con la función pero valor por contenedor 0. */
  sinValorId: string;
  /** Con el concepto de venta inactivo. */
  conceptoInactivoId: string;
};

let fx: Fixture | null = null;
let motivoSinBd: string | null = null;

async function limpiar() {
  const empresas = await prisma.cliente.findMany({ where: { nit: { startsWith: RUN } }, select: { id: true } });
  const ids = empresas.map((e) => e.id);
  const users = await prisma.user.findMany({ where: { email: { startsWith: RUN } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: ids } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
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
        { entidadId: { in: [...tramiteIds, ...borradorIds, ...ids] } },
      ],
    },
  });
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  // Las comisiones ligadas a un «Otros» (Restrict) van antes que los DOs.
  await prisma.comisionTramite.deleteMany({
    where: { OR: [{ tramiteId: { in: tramiteIds } }, { empresaId: { in: ids } }] },
  });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: { startsWith: `VITEST_LIQ_${SUFIJO}` } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function ensureDb(ctx: { skip: (nota?: string) => void }): Fixture {
  if (!fx) {
    ctx.skip(motivoSinBd ?? "BD local no disponible");
    throw new Error("sin BD");
  }
  return fx;
}

const capacidadesLtrans = (opciones: { valor?: string; concepto?: string; reteIva?: number | null; conFormato?: boolean }) => [
  {
    codigo: "comision_por_evento",
    habilitado: true,
    config: {
      unidad: "CONTENEDOR",
      valor: opciones.valor ?? "90000",
      conceptoVenta: opciones.concepto ?? CODIGO_CONCEPTO,
      tipoTramite: "OTRO",
    },
  },
  // Igual que LTRANS en producción: pide contenedores en sus propios DOs.
  { codigo: "contenedores_obligatorio", habilitado: true },
  ...(opciones.conFormato === false
    ? []
    : [
        {
          codigo: "factura_conceptos_iva",
          habilitado: true,
          config: { reteIvaPorcentaje: opciones.reteIva ?? 0, observacionNoRetenciones: true },
        },
      ]),
];

let contadorDo = 0;
/** Un DO de traslado de Polyrec ZF con `unidades` contenedores (o carga suelta = 1) y su comisión de `empresaId`. */
async function comisionEnNuevoDo(
  empresaId: string,
  base: { numContenedores: number } | { suelta: true },
): Promise<{ comisionId: string; consecutivo: string; unidades: number }> {
  const f = fx!;
  contadorDo += 1;
  const tramite = await createTramite({
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId: f.polyrecZfId,
    agenciaAduanas: AgenciaAduanas.COLDEX,
    creadoPorId: f.adminId,
    referenciaExterna: `POLYREC ZF - TRASLADO BL. VITEST ${contadorDo}`,
    ...("suelta" in base ? { tipoCarga: "SUELTA" as const } : { numContenedores: base.numContenedores }),
  });
  const unidades = "suelta" in base ? 1 : base.numContenedores;
  const fila = await registrarComisionTramite({
    tramiteId: tramite.id,
    empresaId,
    unidades,
    usuarioId: f.adminId,
  });
  return { comisionId: fila!.id, consecutivo: tramite.consecutivo, unidades };
}

describe("B10 — facturar comisiones de LTRANS (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      motivoSinBd = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const admin = await prisma.user.create({
        data: { email: `${RUN}@example.test`, emailVerified: true, name: "Vitest Liquidación", rol: Rol.ADMIN },
      });
      await prisma.conceptoVenta.createMany({
        data: [
          { codigo: CODIGO_CONCEPTO, nombre: "COMISIÓN POR CONTENEDOR (vitest)", aplicaIva: true, activo: true },
          { codigo: CODIGO_CONCEPTO_INACTIVO, nombre: "Concepto inactivo (vitest)", aplicaIva: true, activo: false },
        ],
      });
      const crear = (nombre: string, sufijo: string, capacidades: { codigo: string; habilitado: boolean; config?: object }[]) =>
        prisma.cliente.create({
          data: {
            nombre,
            nit: `${RUN}-${sufijo}`,
            tipo: TipoCliente.PROPIO,
            capacidades: capacidades.length ? { create: capacidades } : undefined,
          },
        });
      const polyrecZf = await crear("POLYREC ZF VITEST LIQ", "zf", [
        ...SIN_REQUISITOS_DO,
        { codigo: "contenedores_obligatorio", habilitado: true },
      ]);
      const ltrans = await crear("LTRANS VITEST LIQ", "ltrans", capacidadesLtrans({}));
      const ltrans15 = await crear("LTRANS 15 VITEST LIQ", "ltrans15", capacidadesLtrans({ reteIva: 15 }));
      const ltransConcurrente = await crear("LTRANS CONCURRENTE VITEST LIQ", "ltransconc", capacidadesLtrans({}));
      const sinFormato = await crear("SIN FORMATO VITEST LIQ", "sinformato", capacidadesLtrans({ conFormato: false }));
      const sinValor = await crear("SIN VALOR VITEST LIQ", "sinvalor", capacidadesLtrans({ valor: "0" }));
      const conceptoInactivo = await crear(
        "CONCEPTO INACTIVO VITEST LIQ",
        "conceptooff",
        capacidadesLtrans({ concepto: CODIGO_CONCEPTO_INACTIVO }),
      );
      fx = {
        adminId: admin.id,
        polyrecZfId: polyrecZf.id,
        ltransId: ltrans.id,
        ltrans15Id: ltrans15.id,
        ltransConcurrenteId: ltransConcurrente.id,
        sinFormatoId: sinFormato.id,
        sinValorId: sinValor.id,
        conceptoInactivoId: conceptoInactivo.id,
      };
    } catch (error) {
      motivoSinBd = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (fx) await limpiar();
    await prisma.$disconnect();
  });

  it("L1 · BAQ-18027: 12 contenedores + 3 cargas sueltas = 15 → «Otros» de 1.350.000; la factura da 1.606.500 con ReteIVA 0", async (ctx) => {
    const f = ensureDb(ctx);
    const filas = [
      await comisionEnNuevoDo(f.ltransId, { numContenedores: 5 }),
      await comisionEnNuevoDo(f.ltransId, { numContenedores: 7 }),
      await comisionEnNuevoDo(f.ltransId, { suelta: true }),
      await comisionEnNuevoDo(f.ltransId, { suelta: true }),
      await comisionEnNuevoDo(f.ltransId, { suelta: true }),
    ];

    // Ficha antes: todo por facturar, IVA exacto.
    const antes = await comisionesDeEmpresa(f.ltransId);
    expect(antes.filas).toHaveLength(5);
    expect(antes.facturadas).toEqual([]);
    expect(antes.totales).toEqual({ unidades: 15, subtotal: $(1_350_000), iva: $(256_500), total: $(1_606_500) });

    const r = await liquidarComisiones({
      empresaId: f.ltransId,
      comisionIds: filas.map((x) => x.comisionId),
      usuarioId: f.adminId,
    });
    expect(r.unidades).toBe(15);
    expect(r.valorUnitario).toBe($(90_000));
    expect(r.total).toBe($(1_350_000));
    expect(r.consecutivo).toMatch(/^OTR\d{2}-\d{4}$/);

    // El «Otros»: a nombre de LTRANS, con el valor y el concepto de su config.
    const otros = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: r.tramiteId } });
    expect(otros.clienteId).toBe(f.ltransId);
    expect(otros.tipoTramiteCodigo).toBe("OTRO");
    expect(otros.valorServicio).toBe($(1_350_000));
    expect(otros.conceptoServicioCodigo).toBe(CODIGO_CONCEPTO);
    expect(otros.referenciaExterna).toContain("COMISIÓN POR CONTENEDOR — 15 contenedores");
    for (const fila of filas) expect(otros.referenciaExterna).toContain(fila.consecutivo);

    // Las 5 comisiones quedan ligadas a él; la ficha lo refleja (L6).
    const ligadas = await prisma.comisionTramite.findMany({
      where: { empresaId: f.ltransId },
      select: { liquidacionTramiteId: true, liquidadaEn: true },
    });
    expect(ligadas).toHaveLength(5);
    for (const l of ligadas) {
      expect(l.liquidacionTramiteId).toBe(r.tramiteId);
      expect(l.liquidadaEn).not.toBeNull();
    }
    const despues = await comisionesDeEmpresa(f.ltransId);
    expect(despues.filas).toEqual([]);
    expect(despues.totales).toEqual({ unidades: 0, subtotal: 0n, iva: 0n, total: 0n });
    expect(despues.facturadas).toHaveLength(5);
    expect(despues.facturadas[0]!.otros).toMatchObject({ id: r.tramiteId, consecutivo: r.consecutivo });

    // AuditLog con quién, qué, valor unitario y total.
    const auditoria = await prisma.auditLog.findMany({
      where: { entidad: "Cliente", entidadId: f.ltransId, accion: "LIQUIDAR_COMISIONES" },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ usuarioId: f.adminId, tramiteId: r.tramiteId });
    expect(auditoria[0]!.despues).toMatchObject({ unidades: 15, valorUnitario: "90000", total: "1350000" });

    // Sigue el flujo corto de siempre: mandado a facturar, el borrador da 1.606.500.
    await prisma.tramiteDO.update({ where: { id: r.tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
    const borrador = await generarBorrador({ tramiteId: r.tramiteId, usuarioId: f.adminId });
    const iva = borrador.lineasRevision.find((l) => l.tipoFija === "IVA_COMISION");
    expect(iva?.valor).toBe($(256_500));
    expect(borrador.retenciones).toBe(0n);
    expect(borrador.totalFacturaLineas).toBe($(1_606_500));
  });

  it("L2 · BAQ-18028: 17 contenedores → 1.530.000 + IVA 290.700 = 1.820.700", async (ctx) => {
    const f = ensureDb(ctx);
    const filas = [
      await comisionEnNuevoDo(f.ltransId, { numContenedores: 10 }),
      await comisionEnNuevoDo(f.ltransId, { numContenedores: 6 }),
      await comisionEnNuevoDo(f.ltransId, { suelta: true }),
    ];
    const r = await liquidarComisiones({
      empresaId: f.ltransId,
      comisionIds: filas.map((x) => x.comisionId),
      usuarioId: f.adminId,
    });
    expect(r.unidades).toBe(17);
    expect(r.total).toBe($(1_530_000));

    await prisma.tramiteDO.update({ where: { id: r.tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
    const borrador = await generarBorrador({ tramiteId: r.tramiteId, usuarioId: f.adminId });
    expect(borrador.lineasRevision.find((l) => l.tipoFija === "IVA_COMISION")?.valor).toBe($(290_700));
    expect(borrador.totalFacturaLineas).toBe($(1_820_700));
  });

  it("L3 · con ReteIVA 15 % de la empresa: 1.350.000 + 256.500 − 38.475 = 1.568.025", async (ctx) => {
    const f = ensureDb(ctx);
    const fila = await comisionEnNuevoDo(f.ltrans15Id, { numContenedores: 15 });
    const r = await liquidarComisiones({ empresaId: f.ltrans15Id, comisionIds: [fila.comisionId], usuarioId: f.adminId });
    await prisma.tramiteDO.update({ where: { id: r.tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
    const borrador = await generarBorrador({ tramiteId: r.tramiteId, usuarioId: f.adminId });
    expect(borrador.retenciones).toBe($(38_475));
    expect(borrador.totalFacturaLineas).toBe($(1_568_025));
  });

  it("no se factura dos veces una comisión (409) y no queda un «Otros» de más", async (ctx) => {
    const f = ensureDb(ctx);
    const fila = await comisionEnNuevoDo(f.ltransId, { numContenedores: 2 });
    await liquidarComisiones({ empresaId: f.ltransId, comisionIds: [fila.comisionId], usuarioId: f.adminId });
    const otrosAntes = await prisma.tramiteDO.count({ where: { clienteId: f.ltransId, tipoTramiteCodigo: "OTRO" } });

    await expect(
      liquidarComisiones({ empresaId: f.ltransId, comisionIds: [fila.comisionId], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ name: "ComisionYaLiquidadaError", status: 409, codigo: "COMISION_YA_LIQUIDADA" });
    expect(await prisma.tramiteDO.count({ where: { clienteId: f.ltransId, tipoTramiteCodigo: "OTRO" } })).toBe(otrosAntes);
  });

  it("L4 · dos (o tres) personas facturan las mismas comisiones a la vez: una crea el «Otros», las demás 409 y no queda un DO huérfano", async (ctx) => {
    const f = ensureDb(ctx);
    const filas = [
      await comisionEnNuevoDo(f.ltransConcurrenteId, { numContenedores: 3 }),
      await comisionEnNuevoDo(f.ltransConcurrenteId, { suelta: true }),
    ];
    const input = { empresaId: f.ltransConcurrenteId, comisionIds: filas.map((x) => x.comisionId), usuarioId: f.adminId };

    const resultados = await Promise.allSettled([
      liquidarComisiones(input),
      liquidarComisiones(input),
      liquidarComisiones(input),
    ]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    const fallidas = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(fallidas).toHaveLength(2);
    for (const fallo of fallidas) expect(fallo.reason).toBeInstanceOf(ComisionYaLiquidadaError);

    // Un solo «Otros» de LTRANS, con las dos comisiones ligadas a él.
    const otros = await prisma.tramiteDO.findMany({
      where: { clienteId: f.ltransConcurrenteId, tipoTramiteCodigo: "OTRO" },
      select: { id: true, valorServicio: true },
    });
    expect(otros).toHaveLength(1);
    expect(otros[0]!.valorServicio).toBe($(360_000));
    const ligadas = await prisma.comisionTramite.count({
      where: { empresaId: f.ltransConcurrenteId, liquidacionTramiteId: otros[0]!.id },
    });
    expect(ligadas).toBe(2);
  });

  it("L5 · una comisión ya facturada no se cambia ni se quita; el «Otros» no cambia su valor ni su concepto", async (ctx) => {
    const f = ensureDb(ctx);
    const fila = await comisionEnNuevoDo(f.ltransId, { numContenedores: 4 });
    const tramiteOrigen = await prisma.comisionTramite.findUniqueOrThrow({
      where: { id: fila.comisionId },
      select: { tramiteId: true },
    });
    const r = await liquidarComisiones({ empresaId: f.ltransId, comisionIds: [fila.comisionId], usuarioId: f.adminId });
    const registrar = (unidades: number) =>
      registrarComisionTramite({
        tramiteId: tramiteOrigen.tramiteId,
        empresaId: f.ltransId,
        unidades,
        usuarioId: f.adminId,
      });

    await expect(registrar(2)).rejects.toMatchObject({
      name: "ComisionInvalidaError",
      status: 422,
      message: expect.stringContaining(`ya se facturó en ${r.consecutivo}`),
    });
    await expect(registrar(0)).rejects.toMatchObject({ name: "ComisionInvalidaError", status: 422 });
    // Reenviar lo mismo no cambia nada.
    await expect(registrar(4)).resolves.toMatchObject({ unidades: 4, liquidacionTramiteId: r.tramiteId });
    expect((await comisionesDeTramite(tramiteOrigen.tramiteId)).comisiones).toHaveLength(1);

    // El «Otros»: valor y concepto bloqueados (409); reenviar los mismos, no.
    const base = { tipoTramiteCodigo: "OTRO", tramiteId: r.tramiteId, antes: { valorServicio: r.total, conceptoServicioCodigo: CODIGO_CONCEPTO } };
    await expect(verificarServicioFlujoCorto({ ...base, valorServicio: $(1) })).rejects.toBeInstanceOf(
      ServicioDeComisionesLiquidadasError,
    );
    await expect(verificarServicioFlujoCorto({ ...base, conceptoServicioCodigo: CODIGO_CONCEPTO_INACTIVO })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      verificarServicioFlujoCorto({ ...base, valorServicio: r.total, conceptoServicioCodigo: CODIGO_CONCEPTO }),
    ).resolves.toBeUndefined();
  });

  it("L7 · qué falta: sin formato de factura, sin valor, concepto inactivo, otra empresa o lista vacía → 422 y no se crea nada", async (ctx) => {
    const f = ensureDb(ctx);
    const contarOtros = () => prisma.tramiteDO.count({ where: { clienteId: { in: [f.sinFormatoId, f.sinValorId, f.conceptoInactivoId, f.ltransId] }, tipoTramiteCodigo: "OTRO" } });
    const propia = await comisionEnNuevoDo(f.ltransId, { numContenedores: 1 });
    const deSinFormato = await comisionEnNuevoDo(f.sinFormatoId, { numContenedores: 1 });
    const deSinValor = await comisionEnNuevoDo(f.sinValorId, { numContenedores: 1 });
    const deInactivo = await comisionEnNuevoDo(f.conceptoInactivoId, { numContenedores: 1 });
    const antes = await contarOtros();

    await expect(
      liquidarComisiones({ empresaId: f.sinFormatoId, comisionIds: [deSinFormato.comisionId], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Factura con conceptos e IVA") });
    await expect(
      liquidarComisiones({ empresaId: f.sinValorId, comisionIds: [deSinValor.comisionId], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("valor por contenedor") });
    await expect(
      liquidarComisiones({ empresaId: f.conceptoInactivoId, comisionIds: [deInactivo.comisionId], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining(CODIGO_CONCEPTO_INACTIVO) });
    // Comisión de otra empresa (LTRANS intenta facturar la de SIN FORMATO) e id inexistente.
    await expect(
      liquidarComisiones({ empresaId: f.ltransId, comisionIds: [deSinFormato.comisionId], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      liquidarComisiones({ empresaId: f.ltransId, comisionIds: [propia.comisionId, "no-existe"], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      liquidarComisiones({ empresaId: f.ltransId, comisionIds: [], usuarioId: f.adminId }),
    ).rejects.toMatchObject({ status: 422 });

    expect(await contarOtros()).toBe(antes);
    // La comisión propia sigue "por facturar".
    const ficha = await comisionesDeEmpresa(f.ltransId);
    expect(ficha.filas.map((x) => x.comisionId)).toContain(propia.comisionId);
  });
});
