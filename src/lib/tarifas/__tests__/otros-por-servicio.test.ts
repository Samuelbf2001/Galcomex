/**
 * B2 (Diseño B, 29-sep-2026) — «Otros servicios» con todo lo que necesita la
 * nacionalización, y DUTA + nacionalización conviviendo. Casos dorados N1–N8
 * de `simulacion-camila-27sep/DISENO-B.md` §3.3, al peso, con la BD:
 *
 * - N1  DO.26-0171 como «Otros» (servicio NACIONALIZACION_ZF): 407.000 → total 472.730.
 * - N2  DO.26-0130 con inspección: 539.000 → total 626.048.
 * - N3  igual sin inspección: 439.000 (la OC de 539.000 lo frena en B4).
 * - N4  Z7c CIF 150.000.000: servicio 305.000 → total 530.805.
 * - N5  DUTA: 380.000 → total 441.370.
 * - N6  «Otros» con un servicio sin tarifa y sin valor: 422 VALOR_SERVICIO_REQUERIDO.
 * - N7  publicar «Nacionalización v2» reemplaza solo la de nacionalización.
 * - N8  Plan Vallejo con valor a mano: 406.525, sin campos nuevos.
 * - N9  las tarifas de importación no se enteran.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida; si no, skip.
 * TEST_PREFIX único: "vitest-b2-otros".
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoBorrador, EstadoTarifario, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generarBorrador } from "@/lib/borradores/service";
import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { ValorServicioRequeridoError } from "@/lib/tramites/flujo-corto";
import { tarifaItemSchema, type TarifaItemPayload } from "@/lib/validations/tarifas";

import {
  ConceptoNoEnCatalogoError,
  TarifarioServicioNoAplicaError,
  TarifarioServicioRequeridoError,
  actualizarTarifario,
  cambiarEstadoTarifario,
  crearTarifario,
  duplicarTarifario,
  listarTarifariosLigero,
  propuestaParaTramite,
  tarifarioVigenteDe,
} from "../service";

const TEST_PREFIX = "vitest-b2-otros";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const SUF = Date.now().toString(36).toUpperCase();
const ANIO = 3023;
const DIA = 86_400_000;
const $ = (n: number) => BigInt(n);

const SVC_DUTA = `VTB2${SUF}_DUTA`;
const SVC_NAC = `VTB2${SUF}_NACIONALIZACION_ZF`;
const SVC_LICENCIA = `VTB2${SUF}_LICENCIA`;
const SVC_VALLEJO = `VTB2${SUF}_PLAN_VALLEJO`;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";
let empresaId = "";
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
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.conceptoVenta.deleteMany({ where: { codigo: { startsWith: `VTB2${SUF}` } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de B2";
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

  adminId = (await prisma.user.create({ data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest B2", rol: Rol.ADMIN } })).id;
  empresaId = (await prisma.cliente.create({ data: { nombre: "Cliente vitest B2", nit: `${TEST_PREFIX}-${RUN_ID}`, tipo: TipoCliente.PROPIO } })).id;
  await setCapacidadesEmpresa({
    empresaId,
    cambios: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "factura_conceptos_iva", habilitado: true },
    ],
    usuarioId: adminId,
  });
  for (const [codigo, nombre] of [
    [SVC_DUTA, "DUTA (tránsito aduanero)"],
    [SVC_NAC, "Nacionalización desde zona franca"],
    [SVC_LICENCIA, "Licencia VUCE"],
    [SVC_VALLEJO, "Programa Plan Vallejo"],
  ] as const) {
    await prisma.conceptoVenta.create({ data: { codigo, nombre, activo: true } });
  }
  // Un concepto INACTIVO: no se puede escoger como servicio.
  await prisma.conceptoVenta.create({ data: { codigo: `VTB2${SUF}_INACTIVO`, nombre: "Inactivo", activo: false } });
});

afterAll(async () => {
  if (dbConnected) await limpiar();
});

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

/** D5 — Nacionalización desde zona franca (Polyrec Zona Franca). */
function itemsNacionalizacion(valorInspeccion = 100_000): TarifaItemPayload[] {
  return [
    item({ concepto: "SERVICIO_NACIONALIZACION", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 30, minimos: { SUELTA: "400000", CONTENEDOR_20: "400000", CONTENEDOR_40: "400000" }, restaAgenciamiento: true, minimoEsDelTotal: true, orden: 10 }),
    item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: $(10_000), orden: 20 }),
    item({ concepto: "PAPELERIA", tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: $(12_000), orden: 30 }),
    item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 }),
    item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 50 }),
    item({ concepto: "INSPECCION_DIAN", tipoCalculo: "FIJO", disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", valor: $(valorInspeccion), orden: 60 }),
  ];
}

/** D6 — DUTA: cinco ítems fijos. */
function itemsDuta(): TarifaItemPayload[] {
  return [
    item({ concepto: "SERVICIO_DUTA", tipoCalculo: "FIJO", valor: $(240_000), orden: 10 }),
    item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "FIJO", valor: $(10_000), orden: 20 }),
    item({ concepto: "PAPELERIA", tipoCalculo: "FIJO", valor: $(10_000), orden: 30 }),
    item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: $(20_000), orden: 40 }),
    item({ concepto: "ASESORIA_OPERATIVA", tipoCalculo: "FIJO", valor: $(100_000), orden: 50 }),
  ];
}

async function nuevaTarifa(nombre: string, servicio: string | null, items: TarifaItemPayload[], opciones: { alcance?: string; ciudades?: Ciudad[] } = {}) {
  return crearTarifario({
    empresaId,
    usuarioId: adminId,
    nombre,
    alcance: (opciones.alcance ?? "OTROS") as "OTROS",
    ciudades: opciones.ciudades ?? [],
    conceptoServicioCodigo: servicio,
    vigenteDesde: new Date(Date.now() - 30 * DIA),
    vigenteHasta: new Date(Date.now() + 300 * DIA),
    items,
  });
}

async function publicar(id: string) {
  return cambiarEstadoTarifario(id, "VIGENTE", adminId);
}

async function limpiarTarifarios() {
  await prisma.tarifario.deleteMany({ where: { empresaId } });
}

async function crearDoOtros(o: {
  servicio: string | null;
  valorServicio?: bigint | null;
  cif?: bigint;
  tipoCarga?: "SUELTA";
  declaraciones?: number;
  documentos?: number;
  agencia?: AgenciaAduanas | null;
  inspeccion?: boolean;
  estado?: EstadoTramite;
}) {
  contador += 1;
  const t = await prisma.tramiteDO.create({
    data: {
      consecutivo: `OTR${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${SUF}`,
      tipoTramiteCodigo: "OTRO",
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      numero: contador,
      clienteId: empresaId,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      estado: o.estado ?? EstadoTramite.ENVIADO_A_FACTURAR,
      conceptoServicioCodigo: o.servicio,
      valorServicio: o.valorServicio ?? null,
      valorCif: o.cif ?? null,
      tipoCarga: o.tipoCarga ?? null,
      numDeclaraciones: o.declaraciones ?? null,
      numDocumentos: o.documentos ?? null,
      agenciaAduanas: o.agencia ?? null,
    },
  });
  if (o.inspeccion) {
    await prisma.tramiteEvento.create({ data: { tramiteId: t.id, eventoCodigo: "REVISION_DESPACHO", cantidad: 1, marcadoPorId: adminId } });
  }
  return t.id;
}

describe("B2 — el servicio de una tarifa de «Otros»", () => {
  it("una tarifa de «Otros» exige el servicio, un concepto ACTIVO del catálogo; en otros alcances no se permite", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    await expect(nuevaTarifa("sin servicio", null, itemsDuta())).rejects.toBeInstanceOf(TarifarioServicioRequeridoError);
    await expect(nuevaTarifa("servicio que no existe", `VTB2${SUF}_NO_EXISTE`, itemsDuta())).rejects.toBeInstanceOf(ConceptoNoEnCatalogoError);
    await expect(nuevaTarifa("servicio inactivo", `VTB2${SUF}_INACTIVO`, itemsDuta())).rejects.toBeInstanceOf(ConceptoNoEnCatalogoError);
    await expect(nuevaTarifa("importación con servicio", SVC_DUTA, itemsDuta(), { alcance: "TRAMITE" })).rejects.toBeInstanceOf(TarifarioServicioNoAplicaError);

    const ok = await nuevaTarifa("DUTA", SVC_DUTA, itemsDuta());
    expect(ok.conceptoServicioCodigo).toBe(SVC_DUTA);
    expect(ok.conceptoServicio?.nombre).toBe("DUTA (tránsito aduanero)");
    // Importación: sin servicio, como siempre.
    const imp = await nuevaTarifa("importación", null, itemsDuta(), { alcance: "TRAMITE" });
    expect(imp.conceptoServicioCodigo).toBeNull();
  });

  it("actualizar: el servicio solo se edita en BORRADOR y la combinación alcance + servicio tiene que ser válida", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    const t = await nuevaTarifa("DUTA", SVC_DUTA, itemsDuta());
    const cambiado = await actualizarTarifario(t.id, { conceptoServicioCodigo: SVC_NAC }, adminId);
    expect(cambiado.conceptoServicioCodigo).toBe(SVC_NAC);
    // Quitarlo en «Otros» no se puede.
    await expect(actualizarTarifario(t.id, { conceptoServicioCodigo: null }, adminId)).rejects.toBeInstanceOf(TarifarioServicioRequeridoError);
    // Pasarlo a un alcance sin flujo corto sin quitar el servicio tampoco.
    await expect(actualizarTarifario(t.id, { alcance: "TRAMITE" }, adminId)).rejects.toBeInstanceOf(TarifarioServicioNoAplicaError);

    await publicar(t.id);
    // Ya publicada: solo nombre y notas (el servicio no se cambia en silencio).
    await expect(actualizarTarifario(t.id, { conceptoServicioCodigo: SVC_DUTA }, adminId)).rejects.toThrow(/no se edita/i);
    const renombrada = await actualizarTarifario(t.id, { nombre: "DUTA 2026 (renombrada)" }, adminId);
    expect(renombrada.nombre).toBe("DUTA 2026 (renombrada)");
    expect(renombrada.conceptoServicioCodigo).toBe(SVC_NAC);
  });

  it("el catálogo ligero (copiar la tarifa de otra empresa) trae el servicio", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    const t = await nuevaTarifa("DUTA", SVC_DUTA, itemsDuta());
    const fila = (await listarTarifariosLigero()).find((f) => f.id === t.id);
    expect(fila).toMatchObject({ conceptoServicioCodigo: SVC_DUTA, conceptoServicioNombre: "DUTA (tránsito aduanero)" });
  });
});

describe("B2 — DUTA y nacionalización conviven (publicar por servicio)", () => {
  it("N7 — publicar «Nacionalización v2» reemplaza solo la de nacionalización; la DUTA sigue VIGENTE", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    const duta = await publicar((await nuevaTarifa("DUTA 2026", SVC_DUTA, itemsDuta())).id);
    const nac1 = await publicar((await nuevaTarifa("Nacionalización ZF 2026", SVC_NAC, itemsNacionalizacion())).id);
    expect([duta.estado, nac1.estado]).toEqual([EstadoTarifario.VIGENTE, EstadoTarifario.VIGENTE]);

    const nac2Borrador = await duplicarTarifario(nac1.id, { nombre: "Nacionalización ZF v2", vigenteDesde: new Date(Date.now() - 10 * DIA), vigenteHasta: new Date(Date.now() + 300 * DIA), incrementoPct: 5, redondeoA: 1_000 }, adminId);
    expect(nac2Borrador.conceptoServicioCodigo).toBe(SVC_NAC); // el duplicado copia el servicio
    await publicar(nac2Borrador.id);

    const estados = Object.fromEntries((await prisma.tarifario.findMany({ where: { empresaId } })).map((t) => [t.nombre, t.estado]));
    expect(estados).toEqual({
      "DUTA 2026": EstadoTarifario.VIGENTE,
      "Nacionalización ZF 2026": EstadoTarifario.REEMPLAZADO,
      "Nacionalización ZF v2": EstadoTarifario.VIGENTE,
    });
    // El AuditLog de publicar deja el servicio.
    const log = await prisma.auditLog.findFirst({ where: { entidadId: nac2Borrador.id, accion: "PUBLICAR_TARIFARIO" } });
    expect(log?.despues).toMatchObject({ conceptoServicioCodigo: SVC_NAC, idsReemplazados: [nac1.id] });
  });

  it("los choques de ciudad solo cuentan entre tarifas del MISMO servicio", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    await publicar((await nuevaTarifa("DUTA CTG", SVC_DUTA, itemsDuta(), { ciudades: [Ciudad.CTG] })).id);
    // Nacionalización en CTG y BAQ: no choca con la DUTA de CTG (otro servicio).
    const nac = await publicar((await nuevaTarifa("Nac CTG+BAQ", SVC_NAC, itemsNacionalizacion(), { ciudades: [Ciudad.CTG, Ciudad.BAQ] })).id);
    expect(nac.estado).toBe(EstadoTarifario.VIGENTE);
    expect(await prisma.tarifario.count({ where: { empresaId, estado: EstadoTarifario.VIGENTE } })).toBe(2);
    // Otra DUTA con un conjunto de ciudades distinto que comparte CTG sí choca.
    await expect(publicar((await nuevaTarifa("DUTA CTG+SMR", SVC_DUTA, itemsDuta(), { ciudades: [Ciudad.CTG, Ciudad.SMR] })).id)).rejects.toThrow(/ya está en/i);
  });

  it("tarifarioVigenteDe busca por servicio: undefined = cualquiera (llamadas viejas), null = solo sin servicio, código = solo ese", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    const duta = await publicar((await nuevaTarifa("DUTA", SVC_DUTA, itemsDuta())).id);
    const nac = await publicar((await nuevaTarifa("Nac", SVC_NAC, itemsNacionalizacion())).id);

    expect((await tarifarioVigenteDe(empresaId, "OTROS", undefined, null, SVC_DUTA))?.id).toBe(duta.id);
    expect((await tarifarioVigenteDe(empresaId, "OTROS", undefined, null, SVC_NAC))?.id).toBe(nac.id);
    expect(await tarifarioVigenteDe(empresaId, "OTROS", undefined, null, SVC_LICENCIA)).toBeNull();
    expect(await tarifarioVigenteDe(empresaId, "OTROS", undefined, null, null)).toBeNull();
    expect(await tarifarioVigenteDe(empresaId, "OTROS")).not.toBeNull(); // sin filtro: como antes
  });
});

describe("B2 — la propuesta de un DO de «Otros» (dorados al peso)", () => {
  async function publicarNacionalizacionYDuta() {
    await limpiarTarifarios();
    await publicar((await nuevaTarifa("DUTA 2026", SVC_DUTA, itemsDuta())).id);
    await publicar((await nuevaTarifa("Nacionalización ZF 2026", SVC_NAC, itemsNacionalizacion())).id);
  }

  it("N1 — DO.26-0171: CIF 51.066.071, suelta, 1 declaración, 2 documentos, COLDEX → 255.000 + 20.000 + 12.000 + 20.000 + 100.000 = 407.000 y lo que pide la tarifa", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_NAC, cif: $(51_066_071), tipoCarga: "SUELTA", declaraciones: 1, documentos: 2, agencia: AgenciaAduanas.COLDEX });
    const p = await propuestaParaTramite(t);
    expect(p.resultado?.pendientes).toEqual([]);
    expect(p.resultado?.lineas.map((l) => l.valor)).toEqual([$(255_000), $(20_000), $(12_000), $(20_000), $(100_000)]);
    expect(p.resultado?.total).toBe($(407_000));
    expect(p.camposTarifa).toEqual({
      base: ["valorCif", "tipoCarga", "numDeclaraciones", "numDocumentos"],
      eventos: ["REVISION_DESPACHO"],
      agencia: true,
    });

    // Y la factura: IVA 77.330, ReteIVA 11.600, total 472.730 (la real 472.730,50).
    const b = await generarBorrador({ tramiteId: t, usuarioId: adminId });
    expect(b.formatoFactura).toBe("CONCEPTOS_IVA");
    expect(b.retenciones).toBe($(11_600));
    expect(b.totalFacturaLineas).toBe($(472_730));
  });

  it("N2 — DO.26-0130: CIF 45.454.209, 2 declaraciones, 4 documentos, inspección → 539.000 y total 626.048", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_NAC, cif: $(45_454_209), tipoCarga: "SUELTA", declaraciones: 2, documentos: 4, agencia: AgenciaAduanas.COLDEX, inspeccion: true });
    const p = await propuestaParaTramite(t);
    expect(p.resultado?.lineas.map((l) => l.valor)).toEqual([$(255_000), $(40_000), $(24_000), $(20_000), $(100_000), $(100_000)]);
    expect(p.resultado?.total).toBe($(539_000));
    const b = await generarBorrador({ tramiteId: t, usuarioId: adminId });
    expect(b.totalFacturaLineas).toBe($(626_048));
    expect(b.retenciones).toBe($(15_362));
  });

  it("N3 — el mismo DO sin marcar la inspección: 439.000", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_NAC, cif: $(45_454_209), tipoCarga: "SUELTA", declaraciones: 2, documentos: 4, agencia: AgenciaAduanas.COLDEX });
    expect((await propuestaParaTramite(t)).resultado?.total).toBe($(439_000));
  });

  it("N4 — Z7c, CIF 150.000.000: el servicio pasa del mínimo (305.000), conceptos 457.000 y total 530.805", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_NAC, cif: $(150_000_000), tipoCarga: "SUELTA", declaraciones: 1, documentos: 2, agencia: AgenciaAduanas.COLDEX });
    const p = await propuestaParaTramite(t);
    expect(p.resultado?.lineas[0]?.valor).toBe($(305_000));
    expect(p.resultado?.total).toBe($(457_000));
    const b = await generarBorrador({ tramiteId: t, usuarioId: adminId });
    expect(b.totalFacturaLineas).toBe($(530_805));
    expect(b.retenciones).toBe($(13_025));
  });

  it("sin agencia en el DO la nacionalización queda pendiente (no resta un cero ni cobra de más)", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_NAC, cif: $(51_066_071), tipoCarga: "SUELTA", declaraciones: 1, documentos: 2, agencia: null });
    const p = await propuestaParaTramite(t);
    expect(p.resultado?.pendientes.map((x) => x.concepto)).toEqual(["SERVICIO_NACIONALIZACION"]);
    expect(p.resultado?.pendientes[0]?.motivo).toContain("no tiene agencia de aduanas");
  });

  it("N5 — DUTA como «Otros»: 240.000 + 10.000 + 10.000 + 20.000 + 100.000 = 380.000 y total 441.370; no pide nada al DO", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_DUTA });
    const p = await propuestaParaTramite(t);
    expect(p.resultado?.total).toBe($(380_000));
    expect(p.camposTarifa).toEqual({ base: [], eventos: [], agencia: false });
    const b = await generarBorrador({ tramiteId: t, usuarioId: adminId });
    expect(b.totalFacturaLineas).toBe($(441_370));
  });

  it("N6 — «Otros» con un servicio SIN tarifa y sin valor: no toma el precio de la DUTA; 422 VALOR_SERVICIO_REQUERIDO", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_LICENCIA });
    const p = await propuestaParaTramite(t);
    expect(p.tarifario).toBeNull();
    expect(p.resultado).toBeNull();
    expect(p.motivo).toContain("no tiene un tarifario vigente");
    await expect(generarBorrador({ tramiteId: t, usuarioId: adminId })).rejects.toBeInstanceOf(ValorServicioRequeridoError);
    await expect(generarBorrador({ tramiteId: t, usuarioId: adminId })).rejects.toThrow(
      "Escoge el servicio del DO. Si ese servicio no tiene tarifa para esta empresa, escribe el valor a mano.",
    );
  });

  it("un «Otros» sin servicio: la propuesta pide escogerlo y no busca ninguna tarifa", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: null });
    const p = await propuestaParaTramite(t);
    expect(p.tarifario).toBeNull();
    expect(p.motivo).toBe("Escoge el servicio (concepto de venta) del DO: con él se busca su tarifa");
    await expect(generarBorrador({ tramiteId: t, usuarioId: adminId })).rejects.toBeInstanceOf(ValorServicioRequeridoError);
  });

  it("la DUTA vieja (sin servicio) deja de aplicar hasta recargarla con servicio (D6); recargarla la devuelve a la vida", async (ctx) => {
    ensureDb(ctx);
    await limpiarTarifarios();
    // La DUTA de hoy en producción: «Otros» general, SIN servicio (no se puede crear por la API nueva).
    const vieja = await prisma.tarifario.create({
      data: {
        empresaId,
        nombre: "DUTA 2026 (vieja, sin servicio)",
        alcance: "OTROS",
        estado: EstadoTarifario.VIGENTE,
        vigenteDesde: new Date(Date.now() - 30 * DIA),
        vigenteHasta: new Date(Date.now() + 300 * DIA),
        version: 1,
        creadoPorId: adminId,
      },
    });
    const t = await crearDoOtros({ servicio: SVC_DUTA });
    expect((await propuestaParaTramite(t)).tarifario).toBeNull();

    // Duplicar la vieja SIN servicio no se puede (fuerza a decidir cuál cobra)...
    await expect(
      duplicarTarifario(vieja.id, { nombre: "DUTA 2026", vigenteDesde: new Date(Date.now() - 1 * DIA), vigenteHasta: new Date(Date.now() + 300 * DIA), redondeoA: 1_000 }, adminId),
    ).rejects.toBeInstanceOf(TarifarioServicioRequeridoError);
    // ...con servicio sí.
    const nueva = await duplicarTarifario(vieja.id, { nombre: "DUTA 2026", conceptoServicioCodigo: SVC_DUTA, vigenteDesde: new Date(Date.now() - 1 * DIA), vigenteHasta: new Date(Date.now() + 300 * DIA), redondeoA: 1_000 }, adminId);
    expect(nueva.conceptoServicioCodigo).toBe(SVC_DUTA);
  });

  it("N8 — Plan Vallejo con valor a mano (350.000): 406.525 sin cambio; el panel no muestra campos nuevos", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const t = await crearDoOtros({ servicio: SVC_VALLEJO, valorServicio: $(350_000) });
    const p = await propuestaParaTramite(t);
    // No hay tarifa de ese servicio → sin `camposTarifa`: el panel de un «Otros» no agrega nada.
    expect(p.tarifario).toBeNull();
    expect(p.camposTarifa).toBeUndefined();
    const b = await generarBorrador({ tramiteId: t, usuarioId: adminId });
    expect(b.totalFacturaLineas).toBe($(406_525));
    expect(b.estado).toBe(EstadoBorrador.BORRADOR);
  });

  it("N9 — una tarifa de importación (alcance TRAMITE) no se entera de las de «Otros»: se busca sin servicio, como antes", async (ctx) => {
    ensureDb(ctx);
    await publicarNacionalizacionYDuta();
    const imp = await publicar(
      (await nuevaTarifa("Importación", null, [item({ concepto: "GASTOS_TRAMITE", tipoCalculo: "FIJO", valor: $(433_000), orden: 10 })], { alcance: "TRAMITE" })).id,
    );
    contador += 1;
    const tramite = await prisma.tramiteDO.create({
      data: {
        consecutivo: `DO.BAQ${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${SUF}`,
        tipoTramiteCodigo: "IMPORTACION",
        ciudad: Ciudad.BAQ,
        anio: ANIO,
        numero: contador,
        clienteId: empresaId,
        creadoPorId: adminId,
        comentarios: `${TEST_PREFIX}:${RUN_ID}`,
        estado: EstadoTramite.ENVIADO_A_FACTURAR,
      },
    });
    const p = await propuestaParaTramite(tramite.id);
    expect(p.tarifario?.id).toBe(imp.id);
    expect(p.resultado?.total).toBe($(433_000));
    expect(p.camposTarifa).toEqual({ base: [], eventos: [], agencia: false });
    // Y la búsqueda sin servicio (requisitos, «hay tarifa») sigue viendo la de importación.
    expect((await tarifarioVigenteDe(empresaId, "TRAMITE"))?.id).toBe(imp.id);
  });
});
