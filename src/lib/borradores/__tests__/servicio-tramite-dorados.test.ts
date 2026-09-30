/**
 * Plata al peso con el servicio dentro del trámite normal y el tipo
 * Exportación (DISENO-NUMERACION.md §8, casos 13–19 y 29–31; decisión de
 * Ernesto 30-sep-2026). Las tarifas de nacionalización, traslado y DUTA ya
 * están en «Trámites», cada una con su servicio (como las deja el script de
 * datos), y los DOs son trámites de importación con ese servicio.
 *
 *   13  Nacionalización DO.26-0171 → 407.000; total 472.730; la OC (407.000) cuadra.
 *   14  Nacionalización DO.26-0130 con inspección → 539.000; total 626.048.
 *   15  Traslado 1 contenedor → 348.450.
 *   16  Traslado 2 contenedores → 580.750; Z3 (vacío 262.750 + 4x1000 1.051) → 844.551;
 *       Z3b (1 contenedor + puerto y almacenaje) → 1.753.995.
 *   17  DUTA en Cartagena → 380.000; total 441.370; número DO.CTG…-0251.
 *   18  Exportación Litoplas (tarifa de prueba 40.000 + 20.000 + 100.000) → 185.840,
 *       mandada a facturar SIN pagos aunque Litoplas tenga anticipos; número DO.EXP…-0013.
 *   19  Exportación Coldex a mano 345.000 → 400.717, una línea.
 *   29  Conciliación CxP: «86-0282» encuentra la nacionalización; una fila de
 *       exportación queda sin DO.
 *   30  Cartera: la exportación sale en «Exportación»; la nacionalización, en «Trámites».
 *   31  Un DO de importación general sigue usando SOLO la tarifa general.
 *
 * Valores en pesos; la ReteIVA se redondea al peso (media hacia arriba): los
 * reales con ,50 dan un peso de diferencia. Requiere PostgreSQL local con
 * DATABASE_URL, las migraciones del 30-sep y el parámetro
 * AGENCIAMIENTO_COLDEX = 145000 (como producción); si no, skip.
 * TEST_PREFIX único: "vitest-servicio-dorados". Años: 3042 y 2086.
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONFIG_OC_DEFECTO, desgloseParaOc, evaluarOrdenCompra } from "@/lib/borradores/orden-compra";
import { getCarteraCliente } from "@/lib/cartera/service";
import { setCapacidadesEmpresa, type CambioCapacidad } from "@/lib/capacidades/service";
import { cargarDatosConciliacion, parsearDoExcel, resolverDoExcel, type FilaCartera } from "@/lib/cxp/conciliacion";
import { prisma } from "@/lib/db/prisma";
import { solicitarFacturacion } from "@/lib/facturas-proveedor/service";
import { cambiarEstadoTarifario, crearTarifario, propuestaParaTramite } from "@/lib/tarifas/service";
import { createTramite } from "@/lib/tramites/service";
import { tarifaItemSchema, type TarifaItemPayload } from "@/lib/validations/tarifas";

import { generarBorrador } from "../service";

const TEST_PREFIX = "vitest-servicio-dorados";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 3042;
const ANIO_CXP = 2086;
const DIA = 86_400_000;
const $ = (n: number) => BigInt(n);

let listo = false;
let motivo: string | null = null;
let adminId = "";
let contador = 1_000;
let empresas = 0;

function ensureDb(ctx: { skip: (nota?: string) => void }) {
  if (!listo) ctx.skip(motivo ?? "BD local no disponible");
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({
    where: { OR: [{ clienteId: { in: clienteIds } }, { comentarios: { startsWith: TEST_PREFIX } }] },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);
  const borradores = await prisma.borradorFactura.findMany({ where: { tramiteId: { in: tramiteIds } }, select: { id: true } });
  const borradorIds = borradores.map((b) => b.id);
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...borradorIds, ...clienteIds] } },
        { usuario: { email: { startsWith: TEST_PREFIX } } },
      ],
    },
  });
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteEvento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.consecutivoPiso.deleteMany({ where: { anio: { in: [ANIO, ANIO_CXP] } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivo = "DATABASE_URL no definida";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    if ((await prisma.servicioTramite.count()) === 0) {
      motivo = "La BD no tiene las migraciones del 30-sep-2026";
      return;
    }
    const coldex = await prisma.parametro.findUnique({ where: { clave: "AGENCIAMIENTO_COLDEX" } });
    if (coldex?.valor !== "145000") {
      motivo = "Falta AGENCIAMIENTO_COLDEX = 145000 en la BD de pruebas (dato de producción)";
      return;
    }
  } catch (error) {
    motivo = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  await limpiar();
  adminId = (
    await prisma.user.create({
      data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest servicio dorados", rol: Rol.ADMIN },
    })
  ).id;
  listo = true;
});

afterAll(async () => {
  if (listo) await limpiar();
});

// ─── Datos ────────────────────────────────────────────────────────────────────

async function empresa(nombre: string, extra: CambioCapacidad[] = []) {
  empresas += 1;
  const e = await prisma.cliente.create({
    data: { nombre: `${nombre} ${empresas}`, nit: `${RUN_ID}-${empresas}`, tipo: TipoCliente.PROPIO },
  });
  await setCapacidadesEmpresa({
    empresaId: e.id,
    cambios: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "factura_conceptos_iva", habilitado: true },
      // Estos DOs se crean directo en la BD o con createTramite: los requisitos D1/D2 no son lo que se prueba.
      { codigo: "do_exige_tarifa_vigente", habilitado: false },
      { codigo: "docs_bl_factura_obligatorios", habilitado: false },
      ...extra,
    ],
    usuarioId: adminId,
  });
  return e;
}

function item(over: Partial<TarifaItemPayload> & Pick<TarifaItemPayload, "concepto" | "tipoCalculo" | "orden">): TarifaItemPayload {
  return tarifaItemSchema.parse({
    nombrePublico: over.concepto,
    disparador: "SIEMPRE",
    unidad: "TRAMITE",
    valor: 0n,
    aplicaIva: true,
    restaAgenciamiento: false,
    minimoEsDelTotal: false,
    ...over,
  });
}

/** D5 — «Nacionalización ZF 2026 (supuesto — validar Camila)» de Polyrec ZF. */
const ITEMS_NACIONALIZACION = (): TarifaItemPayload[] => [
  item({ concepto: "SERVICIO_NACIONALIZACION", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 30, minimos: { SUELTA: "400000", CONTENEDOR_20: "400000", CONTENEDOR_40: "400000" }, restaAgenciamiento: true, minimoEsDelTotal: true, orden: 10 }),
  item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: $(10_000), orden: 20 }),
  item({ concepto: "PAPELERIA", tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: $(12_000), orden: 30 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 }),
  item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 50 }),
  item({ concepto: "INSPECCION_DIAN", tipoCalculo: "FIJO", disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", valor: $(100_000), orden: 60 }),
];

/** D6 — «DUTA 2026 (supuesto — validar Camila)». */
const ITEMS_DUTA = (): TarifaItemPayload[] => [
  item({ concepto: "SERVICIO_DUTA", tipoCalculo: "FIJO", valor: $(240_000), orden: 10 }),
  item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "FIJO", valor: $(10_000), orden: 20 }),
  item({ concepto: "PAPELERIA", tipoCalculo: "FIJO", valor: $(10_000), orden: 30 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 }),
  item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 50 }),
];

/** «Traslados zona franca 2026»: 1 contenedor 300.000; 2 o más, 250.000 c/u. */
const ITEMS_TRASLADO = (): TarifaItemPayload[] => [
  item({
    concepto: "TRASLADO_ZF",
    tipoCalculo: "POR_TRAMO",
    unidad: "CONTENEDOR",
    tramos: [
      { hasta: 1, valor: "300000" },
      { hasta: null, valor: "250000" },
    ],
    orden: 10,
  }),
];

async function tarifa(empresaId: string, nombre: string, alcance: string, servicio: string | null, items: TarifaItemPayload[]) {
  const creada = await crearTarifario({
    empresaId,
    usuarioId: adminId,
    nombre,
    alcance: alcance as "TRAMITE",
    ciudades: [],
    conceptoServicioCodigo: servicio,
    vigenteDesde: new Date(Date.now() - 30 * DIA),
    vigenteHasta: new Date(Date.now() + 300 * DIA),
    items,
  });
  return cambiarEstadoTarifario(creada.id, "VIGENTE", adminId);
}

/** Polyrec ZF con sus 3 tarifas en «Trámites» (como las deja el script de datos). */
async function polyrecZf() {
  const e = await empresa("POLYREC ZONA FRANCA VITEST", [
    { codigo: "orden_compra_en_revision", habilitado: true },
  ]);
  await tarifa(e.id, "Nacionalización ZF 2026 (supuesto — validar Camila)", "TRAMITE", "NACIONALIZACION_ZF", ITEMS_NACIONALIZACION());
  await tarifa(e.id, "DUTA 2026 (supuesto — validar Camila)", "TRAMITE", "DUTA", ITEMS_DUTA());
  await tarifa(e.id, "Traslados zona franca 2026", "TRAMITE", "TRASLADO_ZF", ITEMS_TRASLADO());
  return e;
}

async function doFacturable(
  empresaId: string,
  o: {
    servicio: string | null;
    tipo?: string;
    ciudad?: Ciudad;
    cif?: number;
    suelta?: boolean;
    contenedores?: number;
    declaraciones?: number;
    documentos?: number;
    agencia?: AgenciaAduanas | null;
    inspeccion?: boolean;
    valorServicio?: number;
    ordenCompraValor?: number;
    terceros?: number[];
  },
) {
  contador += 1;
  const tipo = o.tipo ?? "IMPORTACION";
  const t = await prisma.tramiteDO.create({
    data: {
      consecutivo: `VT-${tipo}-${contador}-${RUN_ID}`,
      tipoTramiteCodigo: tipo,
      ciudad: o.ciudad ?? Ciudad.BAQ,
      anio: ANIO,
      numero: contador,
      clienteId: empresaId,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      conceptoServicioCodigo: o.servicio,
      valorServicio: o.valorServicio !== undefined ? $(o.valorServicio) : null,
      valorCif: o.cif !== undefined ? $(o.cif) : null,
      tipoCarga: o.suelta ? "SUELTA" : o.contenedores ? "CONTENEDOR_40" : null,
      numContenedores: o.suelta ? 0 : (o.contenedores ?? null),
      numDeclaraciones: o.declaraciones ?? null,
      numDocumentos: o.documentos ?? null,
      agenciaAduanas: o.agencia === undefined ? null : o.agencia,
      ordenCompraNumero: o.ordenCompraValor !== undefined ? "OC11374" : null,
      ordenCompraValor: o.ordenCompraValor !== undefined ? $(o.ordenCompraValor) : null,
    },
  });
  if (o.inspeccion) {
    await prisma.tramiteEvento.create({
      data: { tramiteId: t.id, eventoCodigo: "REVISION_DESPACHO", cantidad: 1, marcadoPorId: adminId },
    });
  }
  for (const [i, valor] of (o.terceros ?? []).entries()) {
    await prisma.facturaProveedor.create({
      data: {
        tramiteId: t.id,
        proveedorNombre: "SOCIEDAD PORTUARIA VITEST",
        numFactura: `FE-${contador}-${i}-${RUN_ID.slice(-8)}`,
        concepto: i === 0 ? "VACIO / PUERTO" : "ALMACENAJE",
        valor: $(valor),
        fecha: new Date("2026-09-20T00:00:00Z"),
        repercutible: true,
        subidaPorId: adminId,
      },
    });
  }
  return t;
}

async function factura(tramiteId: string, comision?: number) {
  return generarBorrador({ tramiteId, usuarioId: adminId, ...(comision !== undefined ? { comision: $(comision) } : {}) });
}

// ─── Casos ────────────────────────────────────────────────────────────────────

describe("nacionalización como trámite de importación (13, 14)", () => {
  it("13 — DO.26-0171: 255.000 + 20.000 + 12.000 + 20.000 + 100.000 = 407.000; IVA 77.330; ReteIVA 11.600; total 472.730; la OC11374 cuadra", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    const t = await doFacturable(polyrec.id, {
      servicio: "NACIONALIZACION_ZF",
      cif: 51_066_071,
      suelta: true,
      declaraciones: 1,
      documentos: 2,
      agencia: AgenciaAduanas.COLDEX,
      ordenCompraValor: 407_000,
    });
    const p = await propuestaParaTramite(t.id);
    expect(p.tarifario?.nombre).toBe("Nacionalización ZF 2026 (supuesto — validar Camila)");
    expect(p.resultado?.pendientes).toEqual([]);
    expect(p.resultado?.lineas.map((l) => l.valor)).toEqual([$(255_000), $(20_000), $(12_000), $(20_000), $(100_000)]);
    expect(p.resultado?.total).toBe($(407_000));
    // El panel del DO marca la inspección como «lo cobra la tarifa de este servicio».
    expect(p.camposTarifa?.eventos).toEqual(["REVISION_DESPACHO"]);

    const b = await factura(t.id);
    expect(b.formatoFactura).toBe("CONCEPTOS_IVA");
    expect(b.retenciones).toBe($(11_600));
    expect(b.totalFacturaLineas).toBe($(472_730));

    const lineas = await prisma.lineaRevision.findMany({
      where: { borradorId: b.id },
      select: { valor: true, seccion: true, tipoFija: true },
    });
    expect(lineas.find((l) => l.tipoFija === "IVA_COMISION")?.valor).toBe($(77_330));
    const oc = evaluarOrdenCompra({
      numero: "OC11374",
      valorOc: $(407_000),
      desglose: desgloseParaOc(lineas),
      config: CONFIG_OC_DEFECTO,
    });
    expect(oc.estado).toBe("CUADRA");
  });

  it("14 — DO.26-0130 con inspección: 255.000 + 40.000 + 24.000 + 20.000 + 100.000 + 100.000 = 539.000; total 626.048", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    const t = await doFacturable(polyrec.id, {
      servicio: "NACIONALIZACION_ZF",
      cif: 45_454_209,
      suelta: true,
      declaraciones: 2,
      documentos: 4,
      agencia: AgenciaAduanas.COLDEX,
      inspeccion: true,
    });
    const p = await propuestaParaTramite(t.id);
    expect(p.resultado?.lineas.map((l) => l.valor)).toEqual([$(255_000), $(40_000), $(24_000), $(20_000), $(100_000), $(100_000)]);
    expect(p.resultado?.total).toBe($(539_000));
    const b = await factura(t.id);
    expect(b.retenciones).toBe($(15_362));
    expect(b.totalFacturaLineas).toBe($(626_048));
  });
});

describe("traslado como trámite de importación (15, 16)", () => {
  it("15 — 1 contenedor: 300.000; IVA 57.000; ReteIVA 8.550; total 348.450", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    const t = await doFacturable(polyrec.id, { servicio: "TRASLADO_ZF", contenedores: 1 });
    const b = await factura(t.id);
    expect(b.comision).toBe($(300_000));
    expect(b.retenciones).toBe($(8_550));
    expect(b.totalFacturaLineas).toBe($(348_450));
  });

  it("16 — 2 contenedores: 250.000 × 2 = 500.000; total 580.750; Z3 → 844.551; Z3b → 1.753.995", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    const dos = await factura((await doFacturable(polyrec.id, { servicio: "TRASLADO_ZF", contenedores: 2 })).id);
    expect(dos.comision).toBe($(500_000));
    expect(dos.retenciones).toBe($(14_250));
    expect(dos.totalFacturaLineas).toBe($(580_750));

    // Z3 — DO.26-0164 / FV-2-18603: 2 × 40 + vacío pagado por Galcomex (262.750) + 4x1000 1.051.
    const z3 = await factura(
      (await doFacturable(polyrec.id, { servicio: "TRASLADO_ZF", contenedores: 2, terceros: [262_750] })).id,
    );
    const lineasZ3 = await prisma.lineaRevision.findMany({ where: { borradorId: z3.id }, select: { valor: true, tipoFija: true } });
    expect(lineasZ3.find((l) => l.tipoFija === "IMPUESTO_4X1000")?.valor).toBe($(1_051));
    expect(z3.totalFacturaLineas).toBe($(844_551));

    // Z3b — 1 contenedor con uso de puerto y almacenaje (1.399.945 en terceros).
    const z3b = await factura(
      (await doFacturable(polyrec.id, { servicio: "TRASLADO_ZF", contenedores: 1, terceros: [700_000, 699_945] })).id,
    );
    expect(z3b.totalFacturaLineas).toBe($(1_753_995));
  });
});

describe("DUTA y exportación (17, 18, 19)", () => {
  it("17 — DUTA en Cartagena: 380.000; IVA 72.200; ReteIVA 10.830; total 441.370; toma el número de Cartagena", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    // Cartagena va en la 0250 (contador propio, no el del grupo).
    await prisma.tramiteDO.create({
      data: {
        consecutivo: `DO.CTG${String(ANIO).slice(-2)}-0250`,
        tipoTramiteCodigo: "IMPORTACION",
        ciudad: Ciudad.CTG,
        anio: ANIO,
        numero: 250,
        clienteId: polyrec.id,
        creadoPorId: adminId,
        comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      },
    });
    const duta = await createTramite({
      ciudad: Ciudad.CTG,
      anio: ANIO,
      clienteId: polyrec.id,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      conceptoServicioCodigo: "DUTA",
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
    });
    expect(duta.consecutivo).toBe(`DO.CTG${String(ANIO).slice(-2)}-0251`);
    await prisma.tramiteDO.update({ where: { id: duta.id }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });

    const p = await propuestaParaTramite(duta.id);
    expect(p.tarifario?.nombre).toBe("DUTA 2026 (supuesto — validar Camila)");
    expect(p.resultado?.total).toBe($(380_000));
    const b = await factura(duta.id);
    expect(b.retenciones).toBe($(10_830));
    expect(b.totalFacturaLineas).toBe($(441_370));
  });

  it("18 — Exportación Litoplas: 40.000 + 20.000 + 100.000 = 160.000; total 185.840; a facturar sin pagos aunque tenga anticipos; DO.EXP…-0013", async (ctx) => {
    ensureDb(ctx);
    const litoplas = await empresa("LITOPLAS VITEST", [{ codigo: "anticipos_cliente", habilitado: true }]);
    // Tarifa de exportación de prueba (la del §3.2 de la preparación), SIN servicio: la general de la línea.
    await tarifa(litoplas.id, "Exportación 2026 (prueba)", "EXPORTACION", null, [
      item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "FIJO", valor: $(40_000), orden: 10 }),
      item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 20 }),
      item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 30 }),
    ]);
    await prisma.consecutivoPiso.create({
      data: {
        // Exportación por ciudad (30-sep-2026): Barranquilla va en el contador de BAQ+BGT+BUN.
        clave: `EXPORTACION:BAQ+BGT+BUN:${ANIO}`,
        tipoTramiteCodigo: "EXPORTACION",
        anio: ANIO,
        ultimoNumero: 12,
        motivo: "Prueba: DO.EXP 0001 a 0012 fuera del tipo",
      },
    });
    const exp = await createTramite({
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      clienteId: litoplas.id,
      tipoTramiteCodigo: "EXPORTACION",
      referenciaExterna: "EX001-26",
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
    });
    expect(exp.consecutivo).toBe(`DO.EXP${String(ANIO).slice(-2)}-0013`);
    expect(exp.conceptoServicioCodigo).toBe("EXPORTACION");

    // Sin ningún pago: el flujo corto no los exige (Litoplas tiene anticipos).
    const r = await solicitarFacturacion(exp.id, adminId);
    expect(r).toEqual({ ok: true });
    const b = await prisma.borradorFactura.findFirstOrThrow({ where: { tramiteId: exp.id } });
    expect(b.comision).toBe($(160_000));
    expect(b.retenciones).toBe($(4_560));
    expect(b.totalFacturaLineas).toBe($(185_840));
  });

  it("19 — Exportación Coldex con 345.000 a mano: IVA 65.550; ReteIVA 9.833; total 400.717; una sola línea", async (ctx) => {
    ensureDb(ctx);
    const coldex = await empresa("COLDEX VITEST");
    const t = await doFacturable(coldex.id, { tipo: "EXPORTACION", servicio: "EXPORTACION", valorServicio: 345_000 });
    const b = await factura(t.id);
    expect(b.formatoFactura).toBe("CONCEPTOS_IVA");
    expect(b.retenciones).toBe($(9_833));
    expect(b.totalFacturaLineas).toBe($(400_717));
    const servicio = await prisma.lineaRevision.findMany({
      where: { borradorId: b.id, seccion: "OPERACIONAL", tipoFija: null },
      select: { valor: true },
    });
    expect(servicio.map((l) => l.valor)).toEqual([$(345_000)]);
  });
});

describe("integraciones y regresión (29, 30, 31)", () => {
  it("29 — conciliación CxP: «86-0282» encuentra la nacionalización DO.BAQ86-0282; una fila de exportación queda sin DO", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    await prisma.consecutivoPiso.create({
      data: {
        clave: `IMPORTACION:BAQ+BGT+BUN:${ANIO_CXP}`,
        tipoTramiteCodigo: "IMPORTACION",
        anio: ANIO_CXP,
        ultimoNumero: 281,
        motivo: "Prueba: el grupo va en la 0281",
      },
    });
    const nac = await createTramite({
      ciudad: Ciudad.BAQ,
      anio: ANIO_CXP,
      clienteId: polyrec.id,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      conceptoServicioCodigo: "NACIONALIZACION_ZF",
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
    });
    expect(nac.consecutivo).toBe("DO.BAQ86-0282");

    const fila = (doTexto: string): FilaCartera => {
      const d = parsearDoExcel(doTexto);
      return {
        archivo: "vitest.xlsx",
        fila: 4,
        factura: "FE 1",
        numeroNormalizado: "FE1",
        marca: "",
        doTexto,
        doAnio: d?.anio ?? null,
        doNumero: d?.numero ?? null,
        fecha: "2086-01-01",
        totalCentavos: 100n,
        pago: null,
      };
    };
    const filas = [fila("86-0282"), fila("DO.EXP86-0013")];
    const datos = await cargarDatosConciliacion(prisma, "000000001", filas);
    const encontrado = resolverDoExcel(filas[0].doAnio, filas[0].doNumero, datos.tramites);
    expect(encontrado.ambiguo).toBe(false);
    expect(encontrado.tramite?.consecutivo).toBe("DO.BAQ86-0282");
    expect(resolverDoExcel(filas[1].doAnio, filas[1].doNumero, datos.tramites)).toEqual({ tramite: null, ambiguo: false });
  });

  it("30 — cartera: la exportación sale con el filtro «Exportación»; la nacionalización, en «Trámites»", async (ctx) => {
    ensureDb(ctx);
    const e = await empresa("EMPRESA VITEST CARTERA");
    const exp = await factura((await doFacturable(e.id, { tipo: "EXPORTACION", servicio: "EXPORTACION", valorServicio: 345_000 })).id);
    const nac = await factura((await doFacturable(e.id, { servicio: "NACIONALIZACION_ZF" })).id, 407_000);
    for (const [i, b] of [exp, nac].entries()) {
      await prisma.factura.create({
        data: {
          borradorId: b.id,
          clienteId: e.id,
          numSiigo: `VT-${i}-${RUN_ID}`,
          fecha: new Date("2026-09-30T00:00:00Z"),
          totalFactura: b.totalFacturaLineas,
          saldoAFavorCliente: 0n,
          saldoACargoCliente: b.totalFacturaLineas,
          saldoAFavorLM: 0n,
          saldoACargoLM: 0n,
        },
      });
    }
    const soloExportacion = await getCarteraCliente({ clienteId: e.id, lineaServicio: "EXPORTACION" });
    expect(soloExportacion.facturas.map((f) => f.borradorId)).toEqual([exp.id]);
    const soloTramites = await getCarteraCliente({ clienteId: e.id, lineaServicio: "TRAMITE" });
    expect(soloTramites.facturas.map((f) => f.borradorId)).toEqual([nac.id]);
  });

  it("31 — un DO de importación general usa SOLO la tarifa general, aunque la empresa tenga tarifas por servicio", async (ctx) => {
    ensureDb(ctx);
    const polyrec = await polyrecZf();
    const general = await tarifa(polyrec.id, "Importación 2026", "TRAMITE", null, [
      item({ concepto: "GASTOS_TRAMITE", tipoCalculo: "FIJO", valor: $(433_000), orden: 10 }),
    ]);
    const imp = await doFacturable(polyrec.id, { servicio: null });
    const p = await propuestaParaTramite(imp.id);
    expect(p.tarifario?.id).toBe(general.id);
    expect(p.resultado?.total).toBe($(433_000));
    expect(p.servicio).toEqual({ codigo: null, nombre: "Importación (tarifa general de la empresa)", claveTarifa: null });

    // Y un traslado de la misma empresa no se entera de la general.
    const tr = await doFacturable(polyrec.id, { servicio: "TRASLADO_ZF", contenedores: 1 });
    expect((await propuestaParaTramite(tr.id)).resultado?.total).toBe($(300_000));
  });
});
