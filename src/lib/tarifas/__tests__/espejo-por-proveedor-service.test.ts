/**
 * B6 (Diseño B, 29-sep-2026) — registro VUCE por proveedor, de punta a punta:
 * contexto del trámite → propuesta del tarifario → borrador de factura, con la
 * factura real FV-2-18521 (DO.CTG26-0148, Sesderma Cartagena) al peso.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida; si no, se
 * omiten (skip). TEST_PREFIX único: "vitest-b6-espejo".
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, DisparadorTarifa, EstadoTarifario, EstadoTramite, Rol, TipoCalculoTarifa, TipoCliente, UnidadTarifa } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generarBorrador, TarifaIncompletaError } from "@/lib/borradores/service";
import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { tarifaItemSchema, tarifaItemUpdateSchema } from "@/lib/validations/tarifas";

import {
  actualizarItemTarifario,
  agregarItemTarifario,
  contextoDeTramite,
  crearTarifario,
  duplicarTarifario,
  propuestaParaTramite,
} from "../service";

const TEST_PREFIX = "vitest-b6-espejo";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const SUF = Date.now().toString(36).toUpperCase();
const ANIO = 3021;
const DIA = 86_400_000;
const $ = (n: number) => BigInt(n);
const CODIGO_PRODUCTO = `VTB6${SUF}`;
const NIT_MINCIT = "830115297";

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";
let clienteId = "";
let productoId = "";
let mincitId = "";
let invimaId = "";
let contador = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  const borradores = await prisma.borradorFactura.findMany({ where: { tramiteId: { in: tramiteIds } }, select: { id: true } });
  const borradorIds = borradores.map((b) => b.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...borradorIds] } },
        { usuario: { email: { startsWith: TEST_PREFIX } } },
      ],
    },
  });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.beneficiario.deleteMany({ where: { nombre: { startsWith: TEST_PREFIX } } });
  await prisma.siigoProducto.deleteMany({ where: { codigo: { startsWith: "VTB6" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de B6";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    dbUnavailableReason = `BD local Postgres no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  dbConnected = true;
  await limpiar();

  const admin = await prisma.user.create({
    data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest B6", rol: Rol.ADMIN },
  });
  adminId = admin.id;
  const cliente = await prisma.cliente.create({
    data: { nombre: "Cliente vitest B6", nit: `${TEST_PREFIX}-${RUN_ID}`, tipo: TipoCliente.PROPIO },
  });
  clienteId = cliente.id;
  await setCapacidadesEmpresa({
    empresaId: clienteId,
    cambios: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "factura_conceptos_iva", habilitado: true },
    ],
    usuarioId: adminId,
  });

  const producto = await prisma.siigoProducto.create({
    data: {
      id: `${RUN_ID}-p24`,
      codigo: CODIGO_PRODUCTO,
      nombre: "PAGO VUCE REG IMP (vitest)",
      tipo: "Service",
      grupoContableId: 1,
      grupoContableNombre: "vitest",
      clasificacionIva: "Taxed",
    },
  });
  productoId = producto.id;
  // NIT del Ministerio de Comercio y del INVIMA: la clave del proveedor la deriva el trigger.
  mincitId = (await prisma.beneficiario.create({ data: { nombre: `${TEST_PREFIX} MINCIT`, nit: NIT_MINCIT } })).id;
  invimaId = (await prisma.beneficiario.create({ data: { nombre: `${TEST_PREFIX} INVIMA`, nit: "860075000" } })).id;
});

afterAll(async () => {
  if (dbConnected) await limpiar();
});

type FacturaFixture = {
  numFactura: string;
  valor: bigint;
  fecha: string;
  concepto: string;
  beneficiarioId?: string;
  producto?: boolean;
  repercutible?: boolean;
};

async function crearTramite(opciones: {
  facturas: FacturaFixture[];
  registros?: number;
  cif?: bigint;
  documentos?: number;
  ciudad?: Ciudad;
}) {
  contador += 1;
  const ciudad = opciones.ciudad ?? Ciudad.CTG;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.${ciudad}${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${RUN_ID.slice(-6)}`,
      ciudad,
      anio: ANIO,
      numero: contador,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      valorCif: opciones.cif ?? 678_819_984n,
      tipoCarga: "SUELTA",
      numContenedores: 0,
      numDeclaraciones: 3,
      numDocumentos: opciones.documentos ?? 6,
    },
  });
  if (opciones.registros) {
    await prisma.tramiteEvento.create({
      data: { tramiteId: tramite.id, eventoCodigo: "ELABORACION_REGISTRO", cantidad: opciones.registros, marcadoPorId: adminId },
    });
  }
  for (const f of opciones.facturas) {
    await prisma.facturaProveedor.create({
      data: {
        tramiteId: tramite.id,
        proveedorNombre: "PROVEEDOR VITEST",
        beneficiarioId: f.beneficiarioId ?? null,
        siigoProductoId: f.producto ? productoId : null,
        // Una factura por (proveedor, número) en todo el sistema: el DO va en el número.
        numFactura: `${f.numFactura}-${contador}-${RUN_ID.slice(-6)}`,
        concepto: f.concepto,
        valor: f.valor,
        fecha: new Date(`${f.fecha}T00:00:00Z`),
        repercutible: f.repercutible ?? true,
        subidaPorId: adminId,
      },
    });
  }
  return tramite.id;
}

/** Las 4 facturas de la VUCE de DO.CTG26-0148, con el producto Siigo 24 en las 4. */
const VUCE_0148: FacturaFixture[] = [
  { numFactura: "64443853", valor: $(46_260), fecha: "2026-06-09", concepto: "PAGO VUCE Vo.Bo INVIMA 50090829 APARATOS", beneficiarioId: "INVIMA", producto: true },
  { numFactura: "491991075", valor: $(83_800), fecha: "2026-06-09", concepto: "PAGO VUCE REGISTRO 50090829 APARATOS", beneficiarioId: "MINCIT", producto: true },
  { numFactura: "611057037", valor: $(832_680), fecha: "2026-06-09", concepto: "PAGO VUCE Vo.Bo INVIMA 50089786 COSMETICOS", beneficiarioId: "INVIMA", producto: true },
  { numFactura: "639483296", valor: $(419_000), fecha: "2026-06-09", concepto: "PAGO VUCE REGISTRO 50089786 COSMETICOS", beneficiarioId: "MINCIT", producto: true },
];

function conFichas(facturas: FacturaFixture[]): FacturaFixture[] {
  return facturas.map((f) => ({
    ...f,
    beneficiarioId: f.beneficiarioId === "MINCIT" ? mincitId : f.beneficiarioId === "INVIMA" ? invimaId : f.beneficiarioId,
  }));
}

/** Los demás terceros de FV-2-18521: transporte, puerto (SPRC). Sin ficha: no hacen falta para el cobro. */
const TERCEROS_0148: FacturaFixture[] = [
  { numFactura: "TIE-493", valor: $(800_000), fecha: "2026-06-05", concepto: "TRANSPORTE LOCAL" },
  { numFactura: "FESP8371902", valor: $(126_501), fecha: "2026-06-02", concepto: "ALMACENAJE" },
  { numFactura: "FESP8371901", valor: $(176_418), fecha: "2026-06-02", concepto: "CONSOLIDACION-DESCONSOLIDACION" },
  { numFactura: "FESP8373508", valor: $(76_717), fecha: "2026-06-05", concepto: "USO CONT, CARGUE CONT" },
];

type ItemDb = {
  concepto: string;
  nombrePublico: string;
  tipoCalculo: TipoCalculoTarifa;
  disparador?: DisparadorTarifa;
  eventoCodigo?: string;
  unidad?: UnidadTarifa;
  valor?: bigint;
  porcentajeBps?: number;
  minimos?: Record<string, string>;
  restaAgenciamiento?: boolean;
  minimoEsDelTotal?: boolean;
  nitProveedorCosto?: string;
  productoCosto?: string;
  conceptoCosto?: string;
  orden: number;
};

async function tarifarioVigente(items: ItemDb[]) {
  return prisma.tarifario.create({
    data: {
      empresaId: clienteId,
      nombre: "Sesderma vitest B6",
      alcance: "TRAMITE",
      estado: EstadoTarifario.VIGENTE,
      vigenteDesde: new Date(Date.now() - 30 * DIA),
      vigenteHasta: new Date(Date.now() + 30 * DIA),
      version: 1,
      creadoPorId: adminId,
      items: {
        create: items.map((i) => ({
          concepto: i.concepto,
          nombrePublico: i.nombrePublico,
          tipoCalculo: i.tipoCalculo,
          disparador: i.disparador ?? DisparadorTarifa.SIEMPRE,
          unidad: i.unidad ?? UnidadTarifa.TRAMITE,
          valor: i.valor ?? 0n,
          porcentajeBps: i.porcentajeBps ?? null,
          minimos: i.minimos ?? undefined,
          aplicaIva: true,
          orden: i.orden,
          restaAgenciamiento: i.restaAgenciamiento ?? false,
          minimoEsDelTotal: i.minimoEsDelTotal ?? false,
          nitProveedorCosto: i.nitProveedorCosto ?? null,
          productoCosto: i.productoCosto ?? null,
          conceptoCosto: i.conceptoCosto ?? null,
          ...(i.eventoCodigo ? { evento: { connect: { codigo: i.eventoCodigo } } } : {}),
        })),
      },
    },
  });
}

/** Tarifa de Sesderma Cartagena (S1b) con el registro por proveedor: mínimo 150.000. */
function itemsSesderma(registro: Partial<ItemDb> = {}): ItemDb[] {
  return [
    { concepto: "ASESORIA_LOGISTICA_CIF", nombrePublico: "ASESORIA LOGISTICA", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 20, minimos: { SUELTA: "450000", CONTENEDOR_20: "450000", CONTENEDOR_40: "450000" }, restaAgenciamiento: true, minimoEsDelTotal: true, orden: 10 },
    { concepto: "COORDINACION_DESPACHO", nombrePublico: "COORDINACION DE DESPACHO", tipoCalculo: "FIJO", valor: $(180_000), orden: 20 },
    { concepto: "REVISION_DOCUMENTAL", nombrePublico: "REVISION DOCUMENTOS", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: $(10_000), orden: 30 },
    { concepto: "PAPELERIA", nombrePublico: "PAPELERÍA", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 },
    { concepto: "SISTEMATIZACION", nombrePublico: "SISTEMATIZACION DE ARCHIVOS", tipoCalculo: "FIJO", valor: $(20_000), orden: 50 },
    { concepto: "GASTOS_OPERATIVOS", nombrePublico: "GASTOS OPERATIVOS", tipoCalculo: "FIJO", valor: $(100_000), orden: 60 },
    {
      concepto: "ELABORACION_REGISTRO",
      nombrePublico: "ELABORACION REGISTRO",
      tipoCalculo: "ESPEJO_DE_COSTO",
      disparador: "EVENTO",
      eventoCodigo: "ELABORACION_REGISTRO",
      valor: $(150_000),
      nitProveedorCosto: NIT_MINCIT,
      productoCosto: CODIGO_PRODUCTO,
      orden: 70,
      ...registro,
    },
  ];
}

/** Tarifa de Sesderma Bogotá: 0,3 % del CIF menos Coldex, coordinación 250.000 y sin papelería. */
function itemsSesdermaBogota(): ItemDb[] {
  return itemsSesderma()
    .filter((i) => i.concepto !== "PAPELERIA")
    .map((i) =>
      i.concepto === "ASESORIA_LOGISTICA_CIF"
        ? { ...i, porcentajeBps: 30, minimos: { SUELTA: "450000" } }
        : i.concepto === "COORDINACION_DESPACHO"
          ? { ...i, valor: $(250_000) }
          : i,
    );
}

describe("B6 — contexto del trámite (contextoDeTramite)", () => {
  it("las facturas de proveedor llevan clave de proveedor, producto Siigo y número, en orden de fecha y número; «NO SE COBRA» no entra (E9)", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite({
      facturas: [
        ...conFichas(VUCE_0148),
        { numFactura: "ASESORIA-1", valor: $(500_000), fecha: "2026-06-09", concepto: "PAGO VUCE REGISTRO (asesoría)", beneficiarioId: mincitId, producto: true, repercutible: false },
      ],
    });
    const c = await contextoDeTramite(tramiteId);
    const espejables = c.costos.filter((x) => x.proveedorClave !== undefined);
    expect(espejables).toHaveLength(4); // la no repercutible no está
    // Misma fecha → por número de factura.
    expect(espejables.map((x) => x.referencia?.split("-")[0])).toEqual(["491991075", "611057037", "639483296", "64443853"]);
    const mincit = espejables.filter((x) => x.proveedorClave === `NIT:${NIT_MINCIT}`);
    expect(mincit.map((x) => x.valor)).toEqual([$(83_800), $(419_000)]);
    expect(espejables.every((x) => x.productoCodigo === CODIGO_PRODUCTO)).toBe(true);
  });
});

describe("B6 — propuesta del tarifario (propuestaParaTramite)", () => {
  it("E1 — 2 facturas del Ministerio + 2 del INVIMA (todas producto 24) → 2 líneas: 150.000 y 419.000", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(itemsSesderma());
    const tramiteId = await crearTramite({ registros: 2, facturas: conFichas(VUCE_0148) });

    const p = await propuestaParaTramite(tramiteId);
    expect(p.resultado?.pendientes).toEqual([]);
    const registro = p.resultado!.lineas.filter((l) => l.concepto === "ELABORACION_REGISTRO");
    expect(registro.map((l) => l.valor)).toEqual([$(150_000), $(419_000)]);
    expect(registro.every((l) => l.origen === "EVENTO" && l.cantidad === 1)).toBe(true);
  });

  it("E6 — evento marcado y ninguna factura del Ministerio → pendiente y generarBorrador 422", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(itemsSesderma());
    // Solo el INVIMA: el Ministerio no está registrado.
    const tramiteId = await crearTramite({
      registros: 1,
      facturas: conFichas(VUCE_0148).filter((f) => f.beneficiarioId === invimaId),
    });
    const p = await propuestaParaTramite(tramiteId);
    expect(p.resultado!.pendientes.map((x) => x.causa)).toEqual(["COSTO_PROVEEDOR"]);
    await expect(generarBorrador({ tramiteId, usuarioId: adminId, usarTarifario: true })).rejects.toBeInstanceOf(
      TarifaIncompletaError,
    );
  });

  it("E7 — evento ×2 con un solo pago del Ministerio → pendiente por conteo", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(itemsSesderma());
    const tramiteId = await crearTramite({
      registros: 2,
      facturas: conFichas(VUCE_0148).filter((f) => f.numFactura === "491991075"),
    });
    const p = await propuestaParaTramite(tramiteId);
    expect(p.resultado!.pendientes).toHaveLength(1);
    expect(p.resultado!.pendientes[0]!.motivo).toContain("Marcaste 2 registros");
    expect(p.resultado!.lineas.filter((l) => l.concepto === "ELABORACION_REGISTRO")).toEqual([]);
  });

  it("E8 — con disparador SIEMPRE y sin registro, el resto de la tarifa sale y no hay pendiente", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(itemsSesderma({ disparador: "SIEMPRE", eventoCodigo: undefined, valor: $(280_000) }));
    const tramiteId = await crearTramite({ facturas: [] });
    const p = await propuestaParaTramite(tramiteId);
    expect(p.resultado!.pendientes).toEqual([]);
    expect(p.resultado!.lineas.some((l) => l.concepto === "ELABORACION_REGISTRO")).toBe(false);
    expect(p.resultado!.lineas.length).toBe(6);
  });
});

describe("B6 — factura completa DO.CTG26-0148 / FV-2-18521 (Diseño A + B6), al peso", () => {
  it("E1 — 5.082.367 (la real 5.082.366,86) con conceptos 2.161.640, IVA 410.712, ReteIVA 61.607 y SIN correcciones a mano", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(itemsSesderma());
    const tramiteId = await crearTramite({
      registros: 2,
      facturas: [...TERCEROS_0148, ...conFichas(VUCE_0148)],
    });

    const borrador = await generarBorrador({ tramiteId, usuarioId: adminId, usarTarifario: true });
    const lineas = await prisma.lineaRevision.findMany({ where: { borradorId: borrador.id }, orderBy: { orden: "asc" } });

    const operacionales = lineas.filter((l) => l.seccion === "OPERACIONAL" && l.tipoFija === null);
    const terceros = lineas.filter((l) => l.seccion === "TERCEROS" && l.tipoFija === null);
    const suma = (ls: { valor: bigint }[]) => ls.reduce((a, l) => a + l.valor, 0n);

    // Las dos líneas de registro salen como la factura real.
    // El nombre lo pone el maestro de conceptos («regla de nombre»), así que se busca por palabra.
    expect(operacionales.filter((l) => /registro/i.test(l.concepto)).map((l) => l.valor)).toEqual([$(150_000), $(419_000)]);
    expect(operacionales.find((l) => /asesor/i.test(l.concepto))?.valor).toBe($(1_212_640));
    expect(suma(operacionales)).toBe($(2_161_640));
    expect(suma(terceros)).toBe($(2_561_376));
    expect(lineas.find((l) => l.tipoFija === "IMPUESTO_4X1000")?.valor).toBe($(10_246));
    expect(lineas.find((l) => l.tipoFija === "IVA_COMISION")?.valor).toBe($(410_712));
    expect(borrador.formatoFactura).toBe("CONCEPTOS_IVA");
    expect(borrador.retenciones).toBe($(61_607));
    expect(borrador.totalFacturaLineas).toBe($(5_082_367));
    expect(borrador.saldoACargoCliente).toBe($(5_082_367));
  });

  it("con la tarifa VIEJA (FIJO 150.000 × 2) la misma factura sale 312.443 más baja: lo que B6 corrige", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(
      itemsSesderma({ tipoCalculo: "FIJO", nitProveedorCosto: undefined, productoCosto: undefined, valor: $(150_000) }),
    );
    const tramiteId = await crearTramite({
      registros: 2,
      facturas: [...TERCEROS_0148, ...conFichas(VUCE_0148)],
    });
    const borrador = await generarBorrador({ tramiteId, usuarioId: adminId, usarTarifario: true });
    expect(borrador.totalFacturaLineas).toBe($(4_769_924)); // = 5.082.367 − 312.443 (DISENO-B §1.1)
  });
});

describe("B6 — factura completa DO.BGT26-0157 / FV-2-18559 (Sesderma Bogotá), al peso", () => {
  it("E2 — un registro (Ministerio 293.300; el INVIMA de 555.120 no cuenta): 3.674.604, conceptos 1.678.270, IVA 318.871, ReteIVA 47.831", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    await tarifarioVigente(itemsSesdermaBogota());
    const tramiteId = await crearTramite({
      ciudad: Ciudad.BGT,
      cif: 366_656_725n,
      registros: 1,
      facturas: [
        { numFactura: "FEVA1497", valor: $(870_000), fecha: "2026-06-12", concepto: "TRANSPORTE" },
        { numFactura: "3550393881", valor: $(293_300), fecha: "2026-06-04", concepto: "PAGO VUCE REG-50111264", beneficiarioId: mincitId, producto: true },
        { numFactura: "514282770", valor: $(555_120), fecha: "2026-06-04", concepto: "PAGO VUCE VoBo INVIMA REG-50111264", beneficiarioId: invimaId, producto: true },
      ],
    });

    const borrador = await generarBorrador({ tramiteId, usuarioId: adminId, usarTarifario: true });
    const lineas = await prisma.lineaRevision.findMany({ where: { borradorId: borrador.id } });
    const suma = (ls: { valor: bigint }[]) => ls.reduce((a, l) => a + l.valor, 0n);

    expect(lineas.find((l) => l.tipoFija === null && l.seccion === "OPERACIONAL" && /registro/i.test(l.concepto))?.valor).toBe($(293_300));
    expect(suma(lineas.filter((l) => l.seccion === "OPERACIONAL" && l.tipoFija === null))).toBe($(1_678_270));
    expect(suma(lineas.filter((l) => l.seccion === "TERCEROS" && l.tipoFija === null))).toBe($(1_718_420));
    expect(lineas.find((l) => l.tipoFija === "IMPUESTO_4X1000")?.valor).toBe($(6_874));
    expect(lineas.find((l) => l.tipoFija === "IVA_COMISION")?.valor).toBe($(318_871));
    expect(borrador.retenciones).toBe($(47_831));
    expect(borrador.totalFacturaLineas).toBe($(3_674_604));
  });
});

describe("B6 — validación y ciclo de vida del ítem", () => {
  const item = {
    concepto: "ELABORACION_REGISTRO",
    nombrePublico: "ELABORACION REGISTRO",
    tipoCalculo: "ESPEJO_DE_COSTO" as const,
    disparador: "EVENTO" as const,
    eventoCodigo: "ELABORACION_REGISTRO",
    valor: $(150_000),
    nitProveedorCosto: NIT_MINCIT,
    productoCosto: "24",
  };

  it("acepta el modo por proveedor sin conceptoCosto; rechaza un NIT con DV o puntos", () => {
    expect(tarifaItemSchema.safeParse(item).success).toBe(true);
    expect(tarifaItemSchema.safeParse({ ...item, nitProveedorCosto: "830.115.297-3" }).success).toBe(false);
    expect(tarifaItemSchema.safeParse({ ...item, nitProveedorCosto: "12" }).success).toBe(false);
  });

  it("solo el NIT, o solo el producto, alcanzan; sin ninguno de los tres se sigue exigiendo el texto", () => {
    expect(tarifaItemSchema.safeParse({ ...item, productoCosto: null }).success).toBe(true);
    expect(tarifaItemSchema.safeParse({ ...item, nitProveedorCosto: null }).success).toBe(true);
    expect(tarifaItemSchema.safeParse({ ...item, nitProveedorCosto: null, productoCosto: null }).success).toBe(false);
    expect(tarifaItemSchema.safeParse({ ...item, nitProveedorCosto: null, productoCosto: null, conceptoCosto: "registro" }).success).toBe(true);
  });

  it("el proveedor solo va con «Lo mismo que costó», y no con disparador manual", () => {
    expect(tarifaItemSchema.safeParse({ ...item, tipoCalculo: "FIJO" }).success).toBe(false);
    expect(tarifaItemSchema.safeParse({ ...item, disparador: "MANUAL", eventoCodigo: null }).success).toBe(false);
  });

  it("agregar, editar (PATCH parcial no pierde el NIT), y duplicar copian nitProveedorCosto y productoCosto", async (ctx) => {
    ensureDb(ctx);
    await prisma.tarifario.deleteMany({ where: { empresaId: clienteId } });
    // El concepto ELABORACION_REGISTRO viene del seed del catálogo.
    const t = await crearTarifario({
      empresaId: clienteId,
      usuarioId: adminId,
      nombre: "vitest B6 ciclo",
      alcance: "TRAMITE",
      vigenteDesde: new Date("3021-01-01"),
      vigenteHasta: new Date("3021-12-31"),
      items: [],
    });
    const conItem = await agregarItemTarifario(t.id, tarifaItemSchema.parse(item), adminId);
    const creado = conItem.items.find((i) => i.concepto === "ELABORACION_REGISTRO")!;
    expect(creado.nitProveedorCosto).toBe(NIT_MINCIT);
    expect(creado.productoCosto).toBe("24");
    expect(creado.valor).toBe($(150_000));

    // PATCH parcial (solo el mínimo): el proveedor y el producto no se pierden.
    const editado = await actualizarItemTarifario(t.id, creado.id, tarifaItemUpdateSchema.parse({ valor: $(160_000) }), adminId);
    const despues = editado.items.find((i) => i.id === creado.id)!;
    expect(despues.valor).toBe($(160_000));
    expect(despues.nitProveedorCosto).toBe(NIT_MINCIT);
    expect(despues.productoCosto).toBe("24");

    const copia = await duplicarTarifario(
      t.id,
      { nombre: "vitest B6 copia", vigenteDesde: new Date("3022-01-01"), vigenteHasta: new Date("3022-12-31"), incrementoPct: 5, redondeoA: 1_000 },
      adminId,
    );
    const copiado = copia.items.find((i) => i.concepto === "ELABORACION_REGISTRO")!;
    expect(copiado.nitProveedorCosto).toBe(NIT_MINCIT);
    expect(copiado.productoCosto).toBe("24");
    expect(copiado.valor).toBe($(168_000)); // el mínimo sube con el IPC: 160.000 × 1,05
  });
});
