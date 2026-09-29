/**
 * B4 (Diseño B, 29-sep-2026) — el freno de la orden de compra al aprobar un
 * borrador, de punta a punta. Casos dorados O1–O10 de
 * `simulacion-camila-27sep/DISENO-B.md` §2.4, al peso:
 *
 * - O1  DO.26-0171 (OC11374 = 407.000): cuadra, aprueba, total 472.730.
 * - O2  DO.26-0130 (427.000 contra OC11104 = 539.000): 422 OC_NO_CUADRA, −112.000.
 * - O3  ADMIN con motivo aprueba y queda AuditLog APROBAR_SIN_CUADRE_OC.
 * - O4  REVISOR con motivo: 403 EXCEPCION_OC_SOLO_ADMIN.
 * - O5  DO.26-0130 corregido (539.000): cuadra; total 626.048.
 * - O6  DO.26-0079 (OC10944 compartida, parte 910.800): cuadra; hermanos 0080 y 0081, suma 1.901.939.
 * - O7  DUTA con uso de puerto: frena por defecto; con SOLO_SERVICIO cuadra.
 * - O8  OC sin valor: 422 OC_SIN_VALOR.
 * - O9  empresa sin la función / formato COMISION: aprueba como hoy.
 * - O10 B8 primero: 409 ANTICIPO_ACTUALIZADO antes que la OC.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida; si no, skip.
 * TEST_PREFIX único: "vitest-b4-oc".
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoBorrador, EstadoTramite, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";

import { crearLineaManual } from "../lineas-service";
import { evaluarOcDeBorrador } from "../orden-compra-service";
import { generarBorrador, transicionarBorrador } from "../service";

const TEST_PREFIX = "vitest-b4-oc";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const SUF = RUN_ID.slice(-6);
const ANIO = 3022;
const $ = (n: number) => BigInt(n);

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";
let revisorId = "";
let clienteOcId = ""; // CONCEPTOS_IVA + orden_compra_en_revision (Polyrec ZF)
let clienteSinOcId = ""; // CONCEPTOS_IVA, sin la función de OC
let clienteComisionId = ""; // sin CONCEPTOS_IVA (formato COMISION), con la función de OC
let clienteOtroId = ""; // otra empresa con CONCEPTOS_IVA + OC (no debe salir como hermana)
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
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  const anticipos = await prisma.anticipo.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  await prisma.aplicacionAnticipo.deleteMany({
    where: { OR: [{ tramiteId: { in: tramiteIds } }, { anticipoId: { in: anticipos.map((a) => a.id) } }] },
  });
  await prisma.anticipo.deleteMany({ where: { id: { in: anticipos.map((a) => a.id) } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

async function crearCliente(nombre: string, capacidades: { codigo: "factura_conceptos_iva" | "orden_compra_en_revision"; config?: Record<string, unknown> }[]) {
  const c = await prisma.cliente.create({
    data: { nombre: `Cliente vitest B4 ${nombre}`, nit: `${TEST_PREFIX}-${nombre}-${RUN_ID}`, tipo: TipoCliente.PROPIO },
  });
  if (capacidades.length > 0) {
    await setCapacidadesEmpresa({
      empresaId: c.id,
      cambios: capacidades.map((x) => ({ codigo: x.codigo, habilitado: true, ...(x.config ? { config: x.config } : {}) })),
      usuarioId: adminId,
    });
  }
  return c.id;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de B4";
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

  adminId = (await prisma.user.create({ data: { email: `${TEST_PREFIX}-admin-${RUN_ID}@example.test`, emailVerified: true, name: "Vitest B4 admin", rol: Rol.ADMIN } })).id;
  revisorId = (await prisma.user.create({ data: { email: `${TEST_PREFIX}-revisor-${RUN_ID}@example.test`, emailVerified: true, name: "Vitest B4 revisor", rol: Rol.REVISOR } })).id;

  clienteOcId = await crearCliente("oc", [{ codigo: "factura_conceptos_iva" }, { codigo: "orden_compra_en_revision" }]);
  clienteSinOcId = await crearCliente("sinoc", [{ codigo: "factura_conceptos_iva" }]);
  clienteComisionId = await crearCliente("comision", [{ codigo: "orden_compra_en_revision" }]);
  clienteOtroId = await crearCliente("otro", [{ codigo: "factura_conceptos_iva" }, { codigo: "orden_compra_en_revision" }]);
});

afterAll(async () => {
  if (dbConnected) await limpiar();
});

type Concepto = { concepto: string; valor: bigint };

async function crearTramite(
  clienteId: string,
  oc: { numero: string | null; valor: bigint | null },
  consecutivoLibre?: string,
) {
  contador += 1;
  const t = await prisma.tramiteDO.create({
    data: {
      consecutivo: consecutivoLibre ?? `DO.BAQ${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${SUF}`,
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      numero: contador,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      ordenCompraNumero: oc.numero,
      ordenCompraValor: oc.valor,
    },
  });
  return t.id;
}

async function crearTercero(tramiteId: string, concepto: string, valor: bigint) {
  contador += 1;
  await prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "PROVEEDOR VITEST",
      numFactura: `F${contador}-${SUF}`,
      concepto,
      valor,
      fecha: new Date(`${ANIO}-01-10T00:00:00Z`),
      repercutible: true,
      subidaPorId: adminId,
    },
  });
}

async function borradorEnRevision(tramiteId: string, conceptos: Concepto[]) {
  const total = conceptos.reduce((a, c) => a + c.valor, 0n);
  const b = await generarBorrador({ tramiteId, usuarioId: adminId, comision: total, conceptosOperacionales: conceptos });
  const rev = await transicionarBorrador({ borradorId: b.id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
  if (!rev.ok) throw new Error(`No pasó a EN_REVISION: ${rev.message}`);
  return b;
}

const aprobarComo = (
  borradorId: string,
  rol: Rol,
  motivoExcepcionOc?: string,
) =>
  transicionarBorrador({
    borradorId,
    nuevoEstado: EstadoBorrador.APROBADO,
    usuarioId: rol === Rol.ADMIN ? adminId : revisorId,
    rolUsuario: rol,
    motivoExcepcionOc,
  });

/** Conceptos de la nacionalización de DO.26-0130 SIN inspección ni la 2.ª declaración: 427.000. */
const CONCEPTOS_0130_INCOMPLETO: Concepto[] = [
  { concepto: "SERVICIO NACIONALIZACION", valor: $(255_000) },
  { concepto: "DOCUMENTACION", valor: $(40_000) },
  { concepto: "PAPELERIA", valor: $(12_000) },
  { concepto: "SISTEMATIZACION", valor: $(20_000) },
  { concepto: "SERVICIO LOGISTICO", valor: $(100_000) },
];
/** DO.26-0130 corregido (2 declaraciones + inspección): 539.000. */
const CONCEPTOS_0130: Concepto[] = [
  { concepto: "SERVICIO NACIONALIZACION", valor: $(255_000) },
  { concepto: "DOCUMENTACION", valor: $(40_000) },
  { concepto: "PAPELERIA", valor: $(24_000) },
  { concepto: "SISTEMATIZACION", valor: $(20_000) },
  { concepto: "SERVICIO LOGISTICO", valor: $(100_000) },
  { concepto: "SERVICIO LOGISTICO INSPECCION", valor: $(100_000) },
];

describe("B4 — la factura cuadra con la orden de compra", () => {
  it("O1 — DO.26-0171 / OC11374 = 407.000: cuadra, aprueba (ADMIN y REVISOR) y el total es 472.730", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11374", valor: $(407_000) });
    const b = await borradorEnRevision(tramiteId, [
      { concepto: "SERVICIO NACIONALIZACION", valor: $(255_000) },
      { concepto: "DOCUMENTACION", valor: $(20_000) },
      { concepto: "PAPELERIA", valor: $(12_000) },
      { concepto: "SISTEMATIZACION", valor: $(20_000) },
      { concepto: "SERVICIO LOGISTICO", valor: $(100_000) },
    ]);
    expect(b.totalFacturaLineas).toBe($(472_730));
    expect(b.retenciones).toBe($(11_600));

    const oc = await evaluarOcDeBorrador(prisma, b.id);
    expect(oc.activa).toBe(true);
    expect(oc.evaluacion.estado).toBe("CUADRA");

    const r = await aprobarComo(b.id, Rol.REVISOR);
    expect(r.ok).toBe(true);
    const guardado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: b.id } });
    expect(guardado.estado).toBe(EstadoBorrador.APROBADO);
    // El snapshot deja con qué se contrastó la factura.
    const snap = guardado.snapshotCalculo as { ordenCompra?: { evaluacion: { estado: string; base: string; valorOc: string } } };
    expect(snap.ordenCompra?.evaluacion).toMatchObject({ estado: "CUADRA", base: "407000", valorOc: "407000" });
  });

  it("O2 — DO.26-0130, 427.000 contra OC11104 = 539.000: 422 OC_NO_CUADRA con diferencia −112.000 y el borrador sigue EN_REVISION", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);

    const r = await aprobarComo(b.id, Rol.REVISOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.codigo).toBe("OC_NO_CUADRA");
    expect(r.message).toContain("La factura suma $427.000 sin impuestos");
    expect(r.message).toContain("OC11104");
    expect(r.message).toContain("$539.000");
    expect(r.message).toContain("faltan $112.000");
    expect(r.detalle).toMatchObject({ estado: "NO_CUADRA", numero: "OC11104", valorOc: "539000", base: "427000", diferencia: "-112000" });

    const guardado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: b.id } });
    expect(guardado.estado).toBe(EstadoBorrador.EN_REVISION);
    expect(guardado.snapshotCalculo).toBeNull();
  });

  it("el ADMIN sin motivo tampoco pasa (la excepción exige el motivo)", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);
    const r = await aprobarComo(b.id, Rol.ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("OC_NO_CUADRA");
  });

  it("O4 — REVISOR con motivo: 403 EXCEPCION_OC_SOLO_ADMIN y no se aprueba", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);
    const r = await aprobarComo(b.id, Rol.REVISOR, "Cliente aceptó la diferencia por correo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.codigo).toBe("EXCEPCION_OC_SOLO_ADMIN");
    const guardado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: b.id } });
    expect(guardado.estado).toBe(EstadoBorrador.EN_REVISION);
  });

  it("sin `rolUsuario` (llamada interna) se trata como no-ADMIN: nunca se salta el freno por omisión", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);
    const r = await transicionarBorrador({
      borradorId: b.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: adminId,
      motivoExcepcionOc: "Cliente aceptó la diferencia por correo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("EXCEPCION_OC_SOLO_ADMIN");
  });

  it("un motivo demasiado corto es 422 MOTIVO_EXCEPCION_OC_CORTO", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);
    const r = await aprobarComo(b.id, Rol.ADMIN, "ok ok");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.codigo).toBe("MOTIVO_EXCEPCION_OC_CORTO");
    }
  });

  it("O3 — ADMIN con motivo aprueba y queda AuditLog APROBAR_SIN_CUADRE_OC con base 427.000 y OC 539.000", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);
    const motivo = "Cliente aceptó la diferencia por correo";

    const r = await aprobarComo(b.id, Rol.ADMIN, motivo);
    expect(r.ok).toBe(true);

    const guardado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: b.id } });
    expect(guardado.estado).toBe(EstadoBorrador.APROBADO);
    expect(guardado.aprobadoPorId).toBe(adminId);
    const snap = guardado.snapshotCalculo as { ordenCompra?: { motivoExcepcion?: string; evaluacion: { estado: string } } };
    expect(snap.ordenCompra?.motivoExcepcion).toBe(motivo);
    expect(snap.ordenCompra?.evaluacion.estado).toBe("NO_CUADRA");

    const log = await prisma.auditLog.findFirst({ where: { entidadId: b.id, accion: "APROBAR_SIN_CUADRE_OC" } });
    expect(log).not.toBeNull();
    expect(log!.usuarioId).toBe(adminId);
    expect(log!.antes).toMatchObject({ estado: "NO_CUADRA", numero: "OC11104", base: "427000", valorOc: "539000", diferencia: "-112000" });
    expect(log!.despues).toEqual({ motivo });
    // Y la aprobación de siempre también queda registrada.
    expect(await prisma.auditLog.count({ where: { entidadId: b.id, accion: "APPROVE" } })).toBe(1);
  });

  it("corregir la factura (agregar los 112.000 que faltaban) la deja aprobar sin excepción", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130_INCOMPLETO);
    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(false);

    // La devolvió a BORRADOR para editarla, agregó la 2.ª declaración y la inspección, y la volvió a mandar.
    await prisma.borradorFactura.update({ where: { id: b.id }, data: { estado: EstadoBorrador.BORRADOR } });
    await crearLineaManual({ borradorId: b.id, concepto: "PAPELERIA 2.ª DECLARACION", valor: $(12_000), seccion: "OPERACIONAL", aplicaIva: true, usuarioId: adminId });
    await crearLineaManual({ borradorId: b.id, concepto: "SERVICIO LOGISTICO INSPECCION", valor: $(100_000), seccion: "OPERACIONAL", aplicaIva: true, usuarioId: adminId });
    const rev = await transicionarBorrador({ borradorId: b.id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    expect(rev.ok).toBe(true);

    const oc = await evaluarOcDeBorrador(prisma, b.id);
    expect(oc.evaluacion.estado).toBe("CUADRA");
    const r = await aprobarComo(b.id, Rol.REVISOR);
    expect(r.ok).toBe(true);
  });

  it("O5 — DO.26-0130 corregido: 539.000 cuadra con la OC y el total es 626.048", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteOcId, { numero: "OC11104", valor: $(539_000) });
    const b = await borradorEnRevision(tramiteId, CONCEPTOS_0130);
    expect(b.totalFacturaLineas).toBe($(626_048));
    const oc = await evaluarOcDeBorrador(prisma, b.id);
    expect(oc.evaluacion.estado).toBe("CUADRA");
    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(true);
  });
});

describe("B4 — OC compartida por varios DOs y reembolsos", () => {
  it("O6 — DO.26-0079 / OC10944: servicio 827.000 + VUCE 83.800 = 910.800 cuadra (el 4x1000 de 335 no entra); hermanos 0080 y 0081 suman 1.901.939", async (ctx) => {
    ensureDb(ctx);
    const t79 = await crearTramite(clienteOcId, { numero: "OC10944", valor: $(910_800) });
    // Mismo número escrito distinto (minúsculas, espacios) y en otra empresa que NO es hermana.
    const t80 = await crearTramite(clienteOcId, { numero: " oc10944", valor: $(439_000) });
    const t81 = await crearTramite(clienteOcId, { numero: "OC10944", valor: $(552_139) });
    await crearTramite(clienteOtroId, { numero: "OC10944", valor: $(999_999) });
    await crearTercero(t79, "PAGO VUCE REGISTRO", $(83_800));

    const b = await borradorEnRevision(t79, [{ concepto: "SERVICIO NACIONALIZACION", valor: $(827_000) }]);
    const lineas = await prisma.lineaRevision.findMany({ where: { borradorId: b.id } });
    expect(lineas.find((l) => l.tipoFija === "IMPUESTO_4X1000")?.valor).toBe($(335));

    const oc = await evaluarOcDeBorrador(prisma, b.id);
    expect(oc.evaluacion.estado).toBe("CUADRA");
    if (oc.evaluacion.estado === "CUADRA") {
      expect(oc.evaluacion.desglose).toEqual({ servicio: $(827_000), terceros: $(83_800), cuatroXMil: $(335) });
      expect(oc.evaluacion.base).toBe($(910_800));
    }
    expect(oc.hermanos.map((h) => h.valorOc).sort()).toEqual([$(439_000), $(552_139)]);
    expect(oc.hermanos).toHaveLength(2);
    expect(oc.hermanos.every((h) => h.consecutivo.length > 0)).toBe(true);
    expect(oc.sumaHermanos).toBe($(1_901_939));
    // t80 y t81 se usan solo como hermanos.
    expect([t80, t81].every(Boolean)).toBe(true);

    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(true);
  });

  it("un DO cuya OC no se comparte no trae hermanos ni suma", async (ctx) => {
    ensureDb(ctx);
    const t = await crearTramite(clienteOcId, { numero: "OC-UNICA", valor: $(100_000) });
    const b = await borradorEnRevision(t, [{ concepto: "SERVICIO", valor: $(100_000) }]);
    const oc = await evaluarOcDeBorrador(prisma, b.id);
    expect(oc.hermanos).toEqual([]);
    expect(oc.sumaHermanos).toBeNull();
  });

  it("O7 — DUTA con uso de puerto 50.000 y OC 380.000: frena por defecto; con base SOLO_SERVICIO cuadra", async (ctx) => {
    ensureDb(ctx);
    const clienteSoloServicio = await crearCliente("soloservicio", [
      { codigo: "factura_conceptos_iva" },
      { codigo: "orden_compra_en_revision", config: { base: "SOLO_SERVICIO" } },
    ]);
    const conceptos: Concepto[] = [
      { concepto: "SERVICIO DUTA", valor: $(240_000) },
      { concepto: "DOCUMENTACION", valor: $(10_000) },
      { concepto: "PAPELERIA", valor: $(10_000) },
      { concepto: "SISTEMATIZACION", valor: $(20_000) },
      { concepto: "SERVICIO LOGISTICO", valor: $(100_000) },
    ];

    const tDefecto = await crearTramite(clienteOcId, { numero: "OC-DUTA-1", valor: $(380_000) });
    await crearTercero(tDefecto, "USO DE PUERTO", $(50_000));
    const bDefecto = await borradorEnRevision(tDefecto, conceptos);
    const rDefecto = await aprobarComo(bDefecto.id, Rol.REVISOR);
    expect(rDefecto.ok).toBe(false);
    if (!rDefecto.ok) {
      expect(rDefecto.codigo).toBe("OC_NO_CUADRA");
      expect(rDefecto.detalle).toMatchObject({ base: "430000", diferencia: "50000" });
    }

    const tSolo = await crearTramite(clienteSoloServicio, { numero: "OC-DUTA-2", valor: $(380_000) });
    await crearTercero(tSolo, "USO DE PUERTO", $(50_000));
    const bSolo = await borradorEnRevision(tSolo, conceptos);
    expect((await aprobarComo(bSolo.id, Rol.REVISOR)).ok).toBe(true);
  });

  it("bloqueaAprobacion en false: avisa pero no frena, y el snapshot deja el resultado", async (ctx) => {
    ensureDb(ctx);
    const clienteAviso = await crearCliente("soloaviso", [
      { codigo: "factura_conceptos_iva" },
      { codigo: "orden_compra_en_revision", config: { bloqueaAprobacion: false } },
    ]);
    const t = await crearTramite(clienteAviso, { numero: "OC-AVISO", valor: $(999_000) });
    const b = await borradorEnRevision(t, [{ concepto: "SERVICIO", valor: $(100_000) }]);
    expect((await evaluarOcDeBorrador(prisma, b.id)).evaluacion.estado).toBe("NO_CUADRA");
    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(true);
    const guardado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: b.id } });
    const snap = guardado.snapshotCalculo as { ordenCompra?: { evaluacion: { estado: string } } };
    expect(snap.ordenCompra?.evaluacion.estado).toBe("NO_CUADRA");
    expect(await prisma.auditLog.count({ where: { entidadId: b.id, accion: "APROBAR_SIN_CUADRE_OC" } })).toBe(0);
  });
});

describe("B4 — OC sin valor y casos que no cambian", () => {
  it("O8 — N° de OC sin valor (Polyrec S.A.S. OC4369): 422 OC_SIN_VALOR; el ADMIN con motivo puede aprobar", async (ctx) => {
    ensureDb(ctx);
    const t = await crearTramite(clienteOcId, { numero: "OC4369", valor: null });
    const b = await borradorEnRevision(t, [{ concepto: "SERVICIO", valor: $(500_000) }]);

    const r = await aprobarComo(b.id, Rol.REVISOR);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.codigo).toBe("OC_SIN_VALOR");
      expect(r.message).toBe("El DO tiene la orden de compra OC4369 sin valor: escribe su valor en el DO o quita el número.");
    }

    const ok = await aprobarComo(b.id, Rol.ADMIN, "La OC es de Polyrec a su proveedor en euros, no aplica");
    expect(ok.ok).toBe(true);
  });

  it("un DO sin N° de OC aprueba como siempre (aunque la empresa tenga la función)", async (ctx) => {
    ensureDb(ctx);
    const t = await crearTramite(clienteOcId, { numero: null, valor: null });
    const b = await borradorEnRevision(t, [{ concepto: "SERVICIO", valor: $(500_000) }]);
    expect((await evaluarOcDeBorrador(prisma, b.id)).evaluacion.estado).toBe("SIN_OC");
    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(true);
  });

  it("O9 — empresa SIN la función de OC: aprueba como hoy aunque el valor no cuadre", async (ctx) => {
    ensureDb(ctx);
    const t = await crearTramite(clienteSinOcId, { numero: "OC-X", valor: $(1_000_000) });
    const b = await borradorEnRevision(t, [{ concepto: "SERVICIO", valor: $(100_000) }]);
    const oc = await evaluarOcDeBorrador(prisma, b.id);
    expect(oc.activa).toBe(false);
    expect(oc.evaluacion.estado).toBe("SIN_OC");
    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(true);
  });

  it("O9 — formato COMISION (sin `factura_conceptos_iva`): no cambia, aprueba como hoy", async (ctx) => {
    ensureDb(ctx);
    const t = await crearTramite(clienteComisionId, { numero: "OC-Y", valor: $(1_000_000) });
    const b = await generarBorrador({ tramiteId: t, usuarioId: adminId, comision: $(100_000) });
    expect(b.formatoFactura).toBe("COMISION");
    const rev = await transicionarBorrador({ borradorId: b.id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    expect(rev.ok).toBe(true);
    expect((await evaluarOcDeBorrador(prisma, b.id)).evaluacion.estado).toBe("SIN_OC");
    expect((await aprobarComo(b.id, Rol.REVISOR)).ok).toBe(true);
  });

  it("O10 — B8 va primero: si el anticipo cambió sale 409 ANTICIPO_ACTUALIZADO (con la OC cuadrando o no)", async (ctx) => {
    ensureDb(ctx);
    for (const valorOc of [$(100_000), $(555_000)]) {
      const t = await crearTramite(clienteOcId, { numero: `OC-B8-${valorOc}`, valor: valorOc });
      const b = await borradorEnRevision(t, [{ concepto: "SERVICIO", valor: $(100_000) }]);
      // Llega un anticipo nuevo al DO después de generar el borrador.
      const anticipo = await prisma.anticipo.create({
        data: { clienteId: clienteOcId, monto: $(50_000), fecha: new Date(`${ANIO}-01-05`), tipoRecaudo: TipoRecaudo.BANCOLOMBIA, costoRecaudo: 1_950n, verificadoBanco: true },
      });
      await prisma.aplicacionAnticipo.create({ data: { anticipoId: anticipo.id, tramiteId: t, montoAplicado: $(50_000) } });

      const r = await aprobarComo(b.id, Rol.REVISOR);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(409);
        expect(r.codigo).toBe("ANTICIPO_ACTUALIZADO");
      }
    }
  });
});
