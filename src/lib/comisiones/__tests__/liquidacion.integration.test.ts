import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoBorrador, EstadoTramite, Rol, SiigoEnvioEstado, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generarBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { deshacerLiquidacion } from "@/lib/comisiones/deshacer-liquidacion";
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
  /** B3: carreras de unidades (una empresa aparte, para contar sus «Otros» sin ruido). */
  ltransCarreraId: string;
  /** M3: deshacer una liquidación. */
  ltransDeshacerId: string;
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
      const ltransCarrera = await crear("LTRANS CARRERA VITEST LIQ", "ltranscarrera", capacidadesLtrans({}));
      const ltransDeshacer = await crear("LTRANS DESHACER VITEST LIQ", "ltransdeshacer", capacidadesLtrans({}));
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
        ltransCarreraId: ltransCarrera.id,
        ltransDeshacerId: ltransDeshacer.id,
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

  it("B3 · los contenedores de una comisión cambian entre la lectura y la facturación → 409, no se crea el «Otros» y la comisión sigue por facturar", async (ctx) => {
    const f = ensureDb(ctx);
    const fila = await comisionEnNuevoDo(f.ltransCarreraId, { numContenedores: 3 });
    const contarOtros = () =>
      prisma.tramiteDO.count({ where: { clienteId: f.ltransCarreraId, tipoTramiteCodigo: "OTRO" } });
    expect(await contarOtros()).toBe(0);

    // Otra persona (T1) cambia 3 → 5 contenedores y todavía no confirma: tiene la fila bloqueada.
    // La liquidación lee la fila ANTES de que T1 confirme (ve 3), se queda esperando el candado al
    // ligarla y, cuando T1 confirma, encuentra 5 → lo cobrado (3 × 90.000) ya no coincide con lo ligado.
    let liquidando!: Promise<unknown>;
    await prisma.$transaction(async (tx) => {
      await tx.comisionTramite.update({ where: { id: fila.comisionId }, data: { unidades: 5 } });
      liquidando = liquidarComisiones({
        empresaId: f.ltransCarreraId,
        comisionIds: [fila.comisionId],
        usuarioId: f.adminId,
      });
      liquidando.catch(() => undefined); // se revisa abajo; evita un rechazo sin manejar mientras esperamos
      await esperarEsperaPorCandadoDeComisiones();
    });
    await expect(liquidando).rejects.toMatchObject({
      name: "ComisionCambioAlLiquidarError",
      status: 409,
      codigo: "COMISION_CAMBIO_AL_LIQUIDAR",
    });

    // Se deshizo todo: ni «Otros» huérfano ni comisión ligada; las unidades nuevas quedan.
    expect(await contarOtros()).toBe(0);
    const despues = await prisma.comisionTramite.findUniqueOrThrow({ where: { id: fila.comisionId } });
    expect(despues.unidades).toBe(5);
    expect(despues.liquidacionTramiteId).toBeNull();

    // Recargando, se factura lo que es: 5 × 90.000 = 450.000.
    const r = await liquidarComisiones({
      empresaId: f.ltransCarreraId,
      comisionIds: [fila.comisionId],
      usuarioId: f.adminId,
    });
    expect(r.unidades).toBe(5);
    expect(r.total).toBe($(450_000));
  });

  it("B3 · editar o quitar una comisión que otra persona factura justo en el medio no la cambia (409)", async (ctx) => {
    const f = ensureDb(ctx);
    const editada = await comisionEnNuevoDo(f.ltransCarreraId, { numContenedores: 4 });
    const quitada = await comisionEnNuevoDo(f.ltransCarreraId, { numContenedores: 2 });
    const ligadora = await comisionEnNuevoDo(f.ltransCarreraId, { numContenedores: 1 });
    const otros = await liquidarComisiones({
      empresaId: f.ltransCarreraId,
      comisionIds: [ligadora.comisionId],
      usuarioId: f.adminId,
    });
    const origen = async (comisionId: string) =>
      (await prisma.comisionTramite.findUniqueOrThrow({ where: { id: comisionId }, select: { tramiteId: true } }))
        .tramiteId;

    for (const [fila, unidadesNuevas] of [
      [editada, 1],
      [quitada, 0],
    ] as const) {
      const tramiteId = await origen(fila.comisionId);
      // T1 tiene la fila bloqueada y la factura (la liga al «Otros» de arriba) antes de confirmar;
      // el registro ya leyó la fila "sin facturar" y se queda esperando el candado.
      let registrando!: Promise<unknown>;
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM comision_tramite WHERE id = ${fila.comisionId} FOR UPDATE`;
        registrando = registrarComisionTramite({
          tramiteId,
          empresaId: f.ltransCarreraId,
          unidades: unidadesNuevas,
          usuarioId: f.adminId,
        });
        registrando.catch(() => undefined);
        await esperarEsperaPorCandadoDeComisiones();
        await tx.comisionTramite.update({
          where: { id: fila.comisionId },
          data: { liquidacionTramiteId: otros.tramiteId, liquidadaEn: new Date() },
        });
      });
      await expect(registrando).rejects.toMatchObject({ name: "ComisionYaFacturadaAlEditarError", status: 409 });

      const despues = await prisma.comisionTramite.findUniqueOrThrow({ where: { id: fila.comisionId } });
      expect(despues.unidades).toBe(fila.unidades); // ni editada ni borrada
      expect(despues.liquidacionTramiteId).toBe(otros.tramiteId);
    }
  });

  // ─── M3 · deshacer una liquidación ──────────────────────────────────────────

  /** Tres DOs (5 + 7 contenedores + 1 carga suelta = 13 → 1.170.000) ya facturados en un «Otros». */
  async function liquidacionDeTrece(empresaId: string) {
    const f = fx!;
    const filas = [
      await comisionEnNuevoDo(empresaId, { numContenedores: 5 }),
      await comisionEnNuevoDo(empresaId, { numContenedores: 7 }),
      await comisionEnNuevoDo(empresaId, { suelta: true }),
    ];
    const r = await liquidarComisiones({ empresaId, comisionIds: filas.map((x) => x.comisionId), usuarioId: f.adminId });
    return { filas, r };
  }

  /** El «Otros» mandado a facturar, con su borrador ya generado. */
  async function borradorDelOtros(tramiteId: string) {
    const f = fx!;
    await prisma.tramiteDO.update({ where: { id: tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
    return generarBorrador({ tramiteId, usuarioId: f.adminId });
  }

  it("M3 · deshacer y volver a liquidar da el mismo total; el «Otros» anulado queda cerrado, sin valor y sin borrador", async (ctx) => {
    const f = ensureDb(ctx);
    const { filas, r } = await liquidacionDeTrece(f.ltransDeshacerId);
    expect(r.total).toBe($(1_170_000));
    const borrador = await borradorDelOtros(r.tramiteId);
    expect(borrador.totalFacturaLineas).toBe($(1_170_000 + 222_300)); // + IVA 19 %

    const antes = await comisionesDeEmpresa(f.ltransDeshacerId);
    expect(antes.filas).toEqual([]);
    expect(antes.facturadas).toHaveLength(3);
    expect(antes.facturadas[0]!.otros).toMatchObject({ id: r.tramiteId, deshacible: true, motivoNoDeshacible: null });

    const resultado = await deshacerLiquidacion({
      empresaId: f.ltransDeshacerId,
      tramiteId: r.tramiteId,
      motivo: "  Faltó incluir un DO en la liquidación  ",
      usuarioId: f.adminId,
    });
    expect(resultado).toMatchObject({
      tramiteId: r.tramiteId,
      comisiones: 3,
      unidades: 13,
      valorAnulado: $(1_170_000),
      borradoresEliminados: 1,
    });

    // Las comisiones vuelven a "por facturar" con las mismas unidades.
    const ficha = await comisionesDeEmpresa(f.ltransDeshacerId);
    expect(ficha.facturadas).toEqual([]);
    expect(ficha.filas.map((x) => x.comisionId).sort()).toEqual(filas.map((x) => x.comisionId).sort());
    expect(ficha.totales).toEqual({ unidades: 13, subtotal: $(1_170_000), iva: $(222_300), total: $(1_392_300) });
    const ligadas = await prisma.comisionTramite.findMany({
      where: { empresaId: f.ltransDeshacerId },
      select: { liquidacionTramiteId: true, liquidadaEn: true },
    });
    for (const l of ligadas) expect(l).toEqual({ liquidacionTramiteId: null, liquidadaEn: null });

    // El «Otros» queda a la vista pero inservible: sin valor, cerrado, con la nota, sin borrador.
    const anulado = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: r.tramiteId } });
    expect(anulado.valorServicio).toBeNull();
    expect(anulado.estado).toBe(EstadoTramite.CERRADO);
    expect(anulado.comentarios).toBe("ANULADO: Faltó incluir un DO en la liquidación");
    expect(anulado.referenciaExterna).toMatch(/^\(ANULADO\) COMISIÓN POR CONTENEDOR — 13 contenedores/);
    expect(await prisma.borradorFactura.count({ where: { tramiteId: r.tramiteId } })).toBe(0);
    const log = await prisma.estadoLog.findFirst({ where: { tramiteId: r.tramiteId }, orderBy: { createdAt: "desc" } });
    expect(log).toMatchObject({ estadoAntes: EstadoTramite.ENVIADO_A_FACTURAR, estadoDes: EstadoTramite.CERRADO });
    // Y no hay forma de cobrarlo: un borrador nuevo sobre el «Otros» anulado se rechaza.
    await expect(generarBorrador({ tramiteId: r.tramiteId, usuarioId: f.adminId })).rejects.toMatchObject({ status: 409 });

    // AuditLog con el motivo, el valor anulado y el borrador eliminado.
    const auditoria = await prisma.auditLog.findMany({
      where: { entidad: "Cliente", entidadId: f.ltransDeshacerId, accion: "DESHACER_LIQUIDACION" },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ usuarioId: f.adminId, tramiteId: r.tramiteId });
    expect(auditoria[0]!.antes).toMatchObject({ valorServicio: "1170000" });
    expect(auditoria[0]!.despues).toMatchObject({ motivo: "Faltó incluir un DO en la liquidación", valorServicio: null });

    // Volver a liquidar las mismas comisiones: otro «Otros», el MISMO total.
    const otra = await liquidarComisiones({
      empresaId: f.ltransDeshacerId,
      comisionIds: filas.map((x) => x.comisionId),
      usuarioId: f.adminId,
    });
    expect(otra.total).toBe(r.total);
    expect(otra.unidades).toBe(13);
    expect(otra.tramiteId).not.toBe(r.tramiteId);
    expect(otra.consecutivo).not.toBe(r.consecutivo);
    // Y el nuevo sí se puede facturar: da lo mismo que el primero.
    const nuevoBorrador = await borradorDelOtros(otra.tramiteId);
    expect(nuevoBorrador.totalFacturaLineas).toBe(borrador.totalFacturaLineas);
  });

  it("M3 · con un borrador EN_REVISION también se puede deshacer (se elimina); con APROBADO o FACTURADO no (409) y no cambia nada", async (ctx) => {
    const f = ensureDb(ctx);

    // EN_REVISION: se descarta.
    const enRevision = await liquidacionDeTrece(f.ltransDeshacerId);
    const b1 = await borradorDelOtros(enRevision.r.tramiteId);
    await prisma.borradorFactura.update({ where: { id: b1.id }, data: { estado: EstadoBorrador.EN_REVISION } });
    await expect(
      deshacerLiquidacion({
        empresaId: f.ltransDeshacerId,
        tramiteId: enRevision.r.tramiteId,
        motivo: "Se creó con el valor equivocado",
        usuarioId: f.adminId,
      }),
    ).resolves.toMatchObject({ borradoresEliminados: 1 });
    expect(await prisma.borradorFactura.count({ where: { id: b1.id } })).toBe(0);

    // APROBADO y FACTURADO: se frena.
    for (const estado of [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO]) {
      const { r } = await liquidacionDeTrece(f.ltransDeshacerId);
      const borrador = await borradorDelOtros(r.tramiteId);
      await prisma.borradorFactura.update({ where: { id: borrador.id }, data: { estado } });

      const ficha = await comisionesDeEmpresa(f.ltransDeshacerId);
      const facturada = ficha.facturadas.find((x) => x.otros.id === r.tramiteId)!;
      expect(facturada.otros.deshacible, estado).toBe(false);
      expect(facturada.otros.motivoNoDeshacible, estado).toContain("factura aprobada o emitida");

      await expect(
        deshacerLiquidacion({
          empresaId: f.ltransDeshacerId,
          tramiteId: r.tramiteId,
          motivo: "Quiero deshacerlo aunque ya está aprobado",
          usuarioId: f.adminId,
        }),
        estado,
      ).rejects.toMatchObject({
        name: "DeshacerLiquidacionImposibleError",
        status: 409,
        codigo: "DESHACER_LIQUIDACION_IMPOSIBLE",
      });

      // Nada cambió: comisiones ligadas, valor intacto, borrador en pie, estado sin tocar.
      const ligadas = await prisma.comisionTramite.count({ where: { liquidacionTramiteId: r.tramiteId } });
      expect(ligadas, estado).toBe(3);
      const otros = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: r.tramiteId } });
      expect(otros.valorServicio, estado).toBe($(1_170_000));
      expect(otros.estado, estado).toBe(EstadoTramite.ENVIADO_A_FACTURAR);
      expect(await prisma.borradorFactura.count({ where: { id: borrador.id, estado } }), estado).toBe(1);
    }
  });

  it("M3 · sin motivo válido 422; otra empresa o «Otros» ya deshecho 404; enviado a Siigo, ya facturado o con pagos → 409", async (ctx) => {
    const f = ensureDb(ctx);
    const { r } = await liquidacionDeTrece(f.ltransDeshacerId);
    const deshacer = (over: Partial<Parameters<typeof deshacerLiquidacion>[0]> = {}) =>
      deshacerLiquidacion({
        empresaId: f.ltransDeshacerId,
        tramiteId: r.tramiteId,
        motivo: "Motivo suficiente para el historial",
        usuarioId: f.adminId,
        ...over,
      });

    // Motivo vacío o de menos de 10 caracteres.
    await expect(deshacer({ motivo: "" })).rejects.toMatchObject({ status: 422 });
    await expect(deshacer({ motivo: "  corto  " })).rejects.toMatchObject({ status: 422 });
    // Otra empresa (LTRANS intenta deshacer la de otra) o un «Otros» que no existe.
    await expect(deshacer({ empresaId: f.ltransCarreraId })).rejects.toMatchObject({ status: 404 });
    await expect(deshacer({ tramiteId: "no-existe" })).rejects.toMatchObject({ status: 404 });

    // Enviado a Siigo (allá puede haber un borrador de factura): no.
    const borrador = await borradorDelOtros(r.tramiteId);
    await prisma.borradorFactura.update({
      where: { id: borrador.id },
      data: { siigoEnvioEstado: SiigoEnvioEstado.INCIERTO },
    });
    await expect(deshacer()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Siigo") });
    // ERROR = Siigo la rechazó sin crearla: se puede deshacer.
    await prisma.borradorFactura.update({
      where: { id: borrador.id },
      data: { siigoEnvioEstado: SiigoEnvioEstado.ERROR },
    });
    await prisma.tramiteDO.update({ where: { id: r.tramiteId }, data: { estado: EstadoTramite.FACTURADO } });
    // Marcado como facturado (aunque no haya factura emitida): no.
    await expect(deshacer()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("facturado o pagado") });
    await prisma.tramiteDO.update({ where: { id: r.tramiteId }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });

    // Ahora sí; y una segunda vez ya no hay comisiones ligadas (404).
    await expect(deshacer()).resolves.toMatchObject({ comisiones: 3, borradoresEliminados: 1 });
    await expect(deshacer()).rejects.toMatchObject({ name: "LiquidacionNoEncontradaError", status: 404 });
  });

  it("M3 · dos personas deshaciendo lo mismo a la vez: una lo hace, la otra 404", async (ctx) => {
    const f = ensureDb(ctx);
    const { r } = await liquidacionDeTrece(f.ltransDeshacerId);
    const input = {
      empresaId: f.ltransDeshacerId,
      tramiteId: r.tramiteId,
      motivo: "Deshacer en simultáneo desde dos pantallas",
      usuarioId: f.adminId,
    };
    const resultados = await Promise.allSettled([deshacerLiquidacion(input), deshacerLiquidacion(input)]);
    expect(resultados.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const fallida = resultados.find((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(fallida?.reason).toMatchObject({ status: 404 });
    expect(
      await prisma.auditLog.count({ where: { entidad: "Cliente", accion: "DESHACER_LIQUIDACION", tramiteId: r.tramiteId } }),
    ).toBe(1);
  });
});

/**
 * Espera (máx. 10 s) a que alguna sentencia sobre `comision_tramite` esté parada
 * esperando un candado de fila: así el test sabe que la otra operación ya llegó
 * a su UPDATE/DELETE antes de dejar avanzar a la transacción que la bloquea.
 */
async function esperarEsperaPorCandadoDeComisiones(): Promise<void> {
  for (let intento = 0; intento < 100; intento += 1) {
    const filas = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%comision_tramite%'`;
    if (Number(filas[0]?.n ?? 0) > 0) return;
    await new Promise((resolver) => setTimeout(resolver, 100));
  }
  throw new Error("Nadie quedó esperando el candado de comision_tramite (¿cambió el orden de las sentencias?)");
}
