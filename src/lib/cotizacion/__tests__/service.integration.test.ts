import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generarBorrador } from "@/lib/borradores/service";
import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { CotizacionIncompletaError, TramiteCotizacionNoEncontradoError, cotizacionDeTramite } from "@/lib/cotizacion/service";
import { prisma } from "@/lib/db/prisma";
import { actualizarParametro } from "@/lib/parametros/service";
import { cambiarEstadoTarifario, crearTarifario } from "@/lib/tarifas/service";
import type { TarifaItemPayload } from "@/lib/validations/tarifas";

/**
 * B7 (Diseño B, 29-sep-2026) — cotización / solicitud de fondos por DO contra
 * Postgres. Lo que se prueba: que sale con LA MISMA cuenta que la pre-factura
 * (mismo total al peso), con los terceros del DO y el 4x1000, con el "valor
 * para la OC" y la nota de la agencia, y qué pasa cuando no se puede cotizar.
 *
 * Caso dorado: DO.26-0171 (Polyrec ZF, FV-2-18589) → 255.000 + 20.000 + 12.000 +
 * 20.000 + 100.000 = 407.000; IVA 77.330; ReteIVA 11.600; total 472.730; OC 407.000;
 * Coldex 145.000 + IVA 27.550 = 172.550. (En producción irá como «Otros» con B2;
 * aquí la tarifa es de importación para no depender de B2 — la cuenta es la misma.)
 */

const RUN = `vitest-cot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const SUFIJO = Date.now().toString(36).toUpperCase();
const CODIGO_CONCEPTO = `VITEST_COT_${SUFIJO}`;
const ANIO = 3016;
const $ = (n: number) => BigInt(n);

type Fixture = {
  adminId: string;
  /** Polyrec ZF: tarifa, ReteIVA 15 %, orden de compra en la revisión. */
  zfId: string;
  /** Con tarifa propia pero sin tarifario vigente. */
  sinTarifaId: string;
  /** Sin `factura_conceptos_iva` (formato de comisión). */
  comisionId: string;
  /** Como LTRANS: ReteIVA 0, sin tarifa (solo «Otros» con valor a mano). */
  ltransId: string;
};

let fx: Fixture | null = null;
let motivoSinBd: string | null = null;
let contador = 0;

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
  const tarifarios = await prisma.tarifario.findMany({ where: { empresaId: { in: ids } }, select: { id: true } });
  const tarifarioIds = tarifarios.map((t) => t.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...borradorIds, ...tarifarioIds, ...ids] } },
      ],
    },
  });
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.cliente.deleteMany({ where: { id: { in: ids } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: CODIGO_CONCEPTO } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function ensureDb(ctx: { skip: (nota?: string) => void }): Fixture {
  if (!fx) {
    ctx.skip(motivoSinBd ?? "BD local no disponible");
    throw new Error("sin BD");
  }
  return fx;
}

function item(over: Partial<TarifaItemPayload> & Pick<TarifaItemPayload, "concepto" | "nombrePublico" | "orden">): TarifaItemPayload {
  return {
    siigoCodigo: null,
    tipoCalculo: "FIJO",
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    notas: null,
    restaAgenciamiento: false,
    minimoEsDelTotal: false,
    ...over,
  };
}

/** La propuesta de nacionalización desde zona franca (FV-2-18589 / DO.26-0171). */
const ITEMS_NACIONALIZACION: TarifaItemPayload[] = [
  item({
    concepto: "SERVICIO_NACIONALIZACION",
    nombrePublico: "LOGÍSTICA DE SUPERVISIÓN Y DESPACHO",
    orden: 10,
    tipoCalculo: "PORCENTAJE_MIN",
    porcentajeBps: 30,
    minimos: { SUELTA: "400000", CONTENEDOR_20: "400000", CONTENEDOR_40: "400000" },
    restaAgenciamiento: true,
    minimoEsDelTotal: true,
  }),
  item({ concepto: "REVISION_DOCUMENTAL", nombrePublico: "DOCUMENTACIÓN", orden: 20, tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: 10_000n }),
  item({ concepto: "PAPELERIA", nombrePublico: "PAPELERÍA", orden: 30, tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: 12_000n }),
  item({ concepto: "SISTEMATIZACION", nombrePublico: "SISTEMATIZACIÓN", orden: 40, valor: 20_000n }),
  item({ concepto: "ASESORIA_OPERATIVA", nombrePublico: "SERVICIO LOGÍSTICO", orden: 50, valor: 100_000n }),
];

async function nuevoDo(
  clienteId: string,
  extra: Partial<{ valorCif: bigint | null; numDocumentos: number | null; agencia: AgenciaAduanas | null }> = {},
) {
  const f = fx!;
  contador += 1;
  return prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${RUN}`,
      tipoTramiteCodigo: "IMPORTACION",
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      numero: contador,
      clienteId,
      creadoPorId: f.adminId,
      comentarios: `${RUN}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      agenciaAduanas: extra.agencia === undefined ? AgenciaAduanas.COLDEX : extra.agencia,
      valorCif: extra.valorCif === undefined ? 51_066_071n : extra.valorCif,
      tipoCarga: "SUELTA",
      numDeclaraciones: 1,
      numDocumentos: extra.numDocumentos === undefined ? 2 : extra.numDocumentos,
      ordenCompraNumero: "OC11374",
      ordenCompraValor: 407_000n,
    },
  });
}

describe("B7 — cotización / solicitud de fondos por DO (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      motivoSinBd = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await limpiar();
      const admin = await prisma.user.create({
        data: { email: `${RUN}@example.test`, emailVerified: true, name: "Vitest Cotización", rol: Rol.ADMIN },
      });
      // Mismo valor que deja el test de Diseño A: el agenciamiento estándar de Coldex.
      await actualizarParametro("AGENCIAMIENTO_COLDEX", "145000", admin.id);
      await prisma.conceptoVenta.create({
        data: { codigo: CODIGO_CONCEPTO, nombre: "COMISIÓN POR CONTENEDOR (vitest)", aplicaIva: true },
      });
      const crear = (nombre: string, sufijo: string, capacidades: { codigo: string; habilitado: boolean; config?: object }[]) =>
        prisma.cliente.create({
          data: { nombre, nit: `${RUN}-${sufijo}`, tipo: TipoCliente.PROPIO, contactoNombre: "Contacto Vitest", capacidades: { create: capacidades } },
        });
      const zf = await crear("POLYREC ZF VITEST COT", "zf", [
        { codigo: "tarifario_propio", habilitado: true },
        { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 15, observacionNoRetenciones: true } },
        { codigo: "orden_compra_en_revision", habilitado: true },
      ]);
      const sinTarifa = await crear("SIN TARIFA VITEST COT", "sintarifa", [
        { codigo: "tarifario_propio", habilitado: true },
        { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 15 } },
      ]);
      const comision = await crear("FORMATO COMISION VITEST COT", "comision", [{ codigo: "tarifario_propio", habilitado: true }]);
      const ltrans = await crear("LTRANS VITEST COT", "ltrans", [
        { codigo: "factura_conceptos_iva", habilitado: true, config: { reteIvaPorcentaje: 0, observacionNoRetenciones: true } },
      ]);

      const tarifario = await crearTarifario({
        empresaId: zf.id,
        usuarioId: admin.id,
        nombre: `Nacionalización ZF ${RUN}`,
        alcance: "TRAMITE",
        vigenteDesde: new Date("2020-01-01"),
        vigenteHasta: new Date("2035-12-31"),
        notas: null,
        items: ITEMS_NACIONALIZACION,
      });
      await cambiarEstadoTarifario(tarifario.id, "VIGENTE", admin.id);
      fx = { adminId: admin.id, zfId: zf.id, sinTarifaId: sinTarifa.id, comisionId: comision.id, ltransId: ltrans.id };
    } catch (error) {
      motivoSinBd = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  afterAll(async () => {
    if (fx) await limpiar();
    await prisma.$disconnect();
  });

  it("DO.26-0171: 407.000 + IVA 77.330 − ReteIVA 11.600 = 472.730; valor para la OC 407.000; nota Coldex 172.550", async (ctx) => {
    const f = ensureDb(ctx);
    const tramite = await nuevoDo(f.zfId);
    const c = await cotizacionDeTramite(tramite.id);

    expect(c.fuente).toBe("TARIFA");
    expect(c.tarifario).toMatchObject({ version: 1 });
    expect(c.conceptos.map((x) => x.valor)).toEqual([$(255_000), $(20_000), $(12_000), $(20_000), $(100_000)]);
    // Sin producto Siigo ni concepto del catálogo, el nombre es el de la tarifa; con ellos, el del catálogo
    // (igual que la línea de la factura; se compara con el borrador en el test siguiente).
    expect(c.conceptos[0]!.concepto).toBe("LOGÍSTICA DE SUPERVISIÓN Y DESPACHO");
    expect(c.conceptos[1]!.concepto).toBe("DOCUMENTACIÓN");
    expect(c.baseConceptos).toBe($(407_000));
    expect(c.iva).toBe($(77_330));
    expect(c.retenciones).toBe($(11_600));
    expect(c.reteIvaPorcentaje).toBe(15);
    expect(c.terceros).toEqual([]);
    expect(c.impuesto4x1000).toBe(0n);
    expect(c.totalAGirar).toBe($(472_730));

    expect(c.usaOrdenCompra).toBe(true);
    expect(c.valorParaOc).toMatchObject({ base: "SERVICIO_Y_TERCEROS", servicio: $(407_000), terceros: 0n, valor: $(407_000) });
    // Lo que el DO tiene registrado como su OC cuadra con lo cotizado.
    expect(c.tramite.ordenCompraNumero).toBe("OC11374");
    expect(c.tramite.ordenCompraValor).toBe(c.valorParaOc.valor);

    expect(c.notaAgencia).toEqual({ agencia: "COLDEX", valor: $(145_000), iva: $(27_550), total: $(172_550) });
    expect(c.textoNotaAgencia).toBe(
      "Orden de compra aparte para COLDEX: 145.000 + IVA 27.550 = 172.550 (la factura la hace Coldex)",
    );
    expect(c.empresa).toMatchObject({ id: f.zfId, contactoNombre: "Contacto Vitest" });
  });

  it("misma cuenta que la pre-factura: el borrador del mismo DO da el mismo total al peso", async (ctx) => {
    const f = ensureDb(ctx);
    const tramite = await nuevoDo(f.zfId);
    const c = await cotizacionDeTramite(tramite.id);

    const borrador = await generarBorrador({ tramiteId: tramite.id, usuarioId: f.adminId });
    expect(borrador.totalFacturaLineas).toBe(c.totalAGirar);
    expect(borrador.totalFacturaLineas).toBe($(472_730));
    expect(borrador.retenciones).toBe(c.retenciones);
    expect(borrador.lineasRevision.find((l) => l.tipoFija === "IVA_COMISION")?.valor).toBe(c.iva);
    // Y las líneas de conceptos son las mismas de la cotización, en el mismo orden.
    const conceptosBorrador = borrador.lineasRevision
      .filter((l) => l.seccion === "OPERACIONAL" && !l.tipoFija)
      .map((l) => l.valor);
    expect(conceptosBorrador).toEqual(c.conceptos.map((x) => x.valor));
    // Y con el mismo nombre que llevará cada línea de la factura.
    const nombresBorrador = borrador.lineasRevision
      .filter((l) => l.seccion === "OPERACIONAL" && !l.tipoFija)
      .map((l) => l.concepto);
    expect(nombresBorrador).toEqual(c.conceptos.map((x) => x.concepto));
  });

  it("con terceros del DO: entran con su 4x1000 y el total sigue igual al de la pre-factura", async (ctx) => {
    const f = ensureDb(ctx);
    const tramite = await nuevoDo(f.zfId);
    await prisma.facturaProveedor.create({
      data: {
        tramiteId: tramite.id,
        proveedorNombre: "ALMACARGA VITEST",
        numFactura: `FE-11298-${RUN}`,
        concepto: "ALMACENAJE",
        valor: 502_801n,
        fecha: new Date("2026-01-15"),
        repercutible: true,
        subidaPorId: f.adminId,
      },
    });
    // No se le cobra al cliente: no entra a la cotización.
    await prisma.facturaProveedor.create({
      data: {
        tramiteId: tramite.id,
        proveedorNombre: "ASCINTER VITEST",
        numFactura: `ASC-1-${RUN}`,
        concepto: "ASESORIA",
        valor: 300_000n,
        fecha: new Date("2026-01-16"),
        repercutible: false,
        subidaPorId: f.adminId,
      },
    });

    const c = await cotizacionDeTramite(tramite.id);
    expect(c.terceros).toHaveLength(1);
    expect(c.terceros[0]).toMatchObject({ valor: $(502_801), numSoporte: `FE-11298-${RUN}` });
    expect(c.terceros[0]!.concepto).toContain("ALMACENAJE");
    expect(c.baseTerceros).toBe($(502_801));
    expect(c.impuesto4x1000).toBe($(2_011));
    // 407.000 + 77.330 − 11.600 + 502.801 + 2.011
    expect(c.totalAGirar).toBe($(977_542));
    // Valor para la OC: servicio + terceros (sin IVA, ReteIVA ni 4x1000).
    expect(c.valorParaOc.valor).toBe($(909_801));

    const borrador = await generarBorrador({ tramiteId: tramite.id, usuarioId: f.adminId });
    expect(borrador.totalFacturaLineas).toBe(c.totalAGirar);

    // La regla de la OC es configurable por empresa (solo el servicio).
    await setCapacidadesEmpresa({
      empresaId: f.zfId,
      cambios: [{ codigo: "orden_compra_en_revision", habilitado: true, config: { base: "SOLO_SERVICIO", incluye4x1000: false } }],
      usuarioId: f.adminId,
    });
    expect((await cotizacionDeTramite(tramite.id)).valorParaOc.valor).toBe($(407_000));
    await setCapacidadesEmpresa({
      empresaId: f.zfId,
      cambios: [{ codigo: "orden_compra_en_revision", habilitado: true, config: null }],
      usuarioId: f.adminId,
    });
  });

  it("sin agencia (o sin agenciamiento estándar) no hay nota; sin la función de OC no se imprime el valor para la OC", async (ctx) => {
    const f = ensureDb(ctx);
    const sinAgencia = await nuevoDo(f.zfId, { agencia: null });
    const c = await cotizacionDeTramite(sinAgencia.id).catch((e: unknown) => e);
    // Sin agencia el ítem que resta su agenciamiento queda pendiente: no se cotiza a medias.
    expect(c).toBeInstanceOf(CotizacionIncompletaError);
    expect((c as CotizacionIncompletaError).pendientes.length).toBeGreaterThan(0);

    // Empresa sin `orden_compra_en_revision`: la cotización sale, sin "valor para la OC".
    await setCapacidadesEmpresa({
      empresaId: f.zfId,
      cambios: [{ codigo: "orden_compra_en_revision", habilitado: false }],
      usuarioId: f.adminId,
    });
    try {
      const conAgencia = await nuevoDo(f.zfId);
      const sinOc = await cotizacionDeTramite(conAgencia.id);
      expect(sinOc.usaOrdenCompra).toBe(false);
      expect(sinOc.totalAGirar).toBe($(472_730));
    } finally {
      await setCapacidadesEmpresa({
        empresaId: f.zfId,
        cambios: [{ codigo: "orden_compra_en_revision", habilitado: true }],
        usuarioId: f.adminId,
      });
    }
  });

  it("no se puede cotizar: sin tarifa vigente, con la base de cálculo incompleta o con el formato de comisión → 422 COTIZACION_INCOMPLETA", async (ctx) => {
    const f = ensureDb(ctx);

    const sinTarifa = await nuevoDo(f.sinTarifaId);
    await expect(cotizacionDeTramite(sinTarifa.id)).rejects.toMatchObject({
      name: "CotizacionIncompletaError",
      status: 422,
      codigo: "COTIZACION_INCOMPLETA",
      message: expect.stringContaining("No hay tarifa para cotizar"),
    });

    const sinCif = await nuevoDo(f.zfId, { valorCif: null });
    const error = await cotizacionDeTramite(sinCif.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CotizacionIncompletaError);
    expect((error as CotizacionIncompletaError).pendientes.some((p) => p.causa === "BASE_DO")).toBe(true);
    expect((error as CotizacionIncompletaError).message).toContain("no se puede aplicar completo");

    const formatoComision = await nuevoDo(f.comisionId);
    await expect(cotizacionDeTramite(formatoComision.id)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("formato de comisión"),
    });

    await expect(cotizacionDeTramite("no-existe")).rejects.toBeInstanceOf(TramiteCotizacionNoEncontradoError);
  });

  it("un «Otros» con valor a mano (p. ej. las comisiones de LTRANS) se cotiza igual que se facturaría: 1.350.000 + IVA = 1.606.500", async (ctx) => {
    const f = ensureDb(ctx);
    contador += 1;
    const otros = await prisma.tramiteDO.create({
      data: {
        consecutivo: `OTR${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${RUN}`,
        tipoTramiteCodigo: "OTRO",
        ciudad: Ciudad.BAQ,
        anio: ANIO,
        numero: contador,
        clienteId: f.ltransId,
        creadoPorId: f.adminId,
        comentarios: RUN,
        estado: EstadoTramite.ENVIADO_A_FACTURAR,
        valorServicio: 1_350_000n,
        conceptoServicioCodigo: CODIGO_CONCEPTO,
        referenciaExterna: "COMISIÓN POR CONTENEDOR — 15 contenedores",
      },
    });
    const c = await cotizacionDeTramite(otros.id);
    expect(c.fuente).toBe("VALOR");
    expect(c.tarifario).toBeNull();
    expect(c.conceptos).toHaveLength(1);
    expect(c.conceptos[0]).toMatchObject({ valor: $(1_350_000), aplicaIva: true, concepto: "COMISIÓN POR CONTENEDOR (vitest)" });
    expect(c.iva).toBe($(256_500));
    expect(c.retenciones).toBe(0n);
    expect(c.reteIvaManual).toBe(false);
    expect(c.totalAGirar).toBe($(1_606_500));
    expect(c.usaOrdenCompra).toBe(false);
    expect(c.notaAgencia).toBeNull();

    const borrador = await generarBorrador({ tramiteId: otros.id, usuarioId: f.adminId });
    expect(borrador.totalFacturaLineas).toBe(c.totalAGirar);

    // Sin valor ni tarifa no hay con qué cotizar.
    contador += 1;
    const vacio = await prisma.tramiteDO.create({
      data: {
        consecutivo: `OTR${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${RUN}`,
        tipoTramiteCodigo: "OTRO",
        ciudad: Ciudad.BAQ,
        anio: ANIO,
        numero: contador,
        clienteId: f.ltransId,
        creadoPorId: f.adminId,
        comentarios: RUN,
      },
    });
    await expect(cotizacionDeTramite(vacio.id)).rejects.toMatchObject({ status: 422, codigo: "COTIZACION_INCOMPLETA" });
  });
});
