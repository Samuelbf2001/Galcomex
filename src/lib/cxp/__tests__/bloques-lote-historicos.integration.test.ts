/**
 * CxP v2 — migración 20260925100250_cxp_v2_bloques_lote_historicos contra
 * Postgres real. Requiere DATABASE_URL de una base de pruebas desechable
 * migrada con M1–M5; sin BD los tests se omiten.
 *
 * La carga histórica D0 (lote HIST-PLATA-2026-09-23) dejó pagos de cartera sin
 * comprobante agrupados por un grupoPagoId que M3 convirtió en bloques
 * «Activos». La migración los marca `esHistorico` (y GALCOMEX, como un bloque
 * histórico de la app). Aquí se arman a mano, como los dejó M3, un bloque del
 * lote y varios que NO deben tocarse, se corre el SQL de la migración tal cual
 * está en el repo y se comprueba qué cambió. También que `re-avance-v2.sql`
 * repite exactamente el mismo UPDATE.
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CanalPago, CategoriaDocumento, Ciudad, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

const PREFIJO = "vitest-cxp-lote-hist";
const runId = `${PREFIJO}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 3022;
const LOTE = "HIST-PLATA-2026-09-23";

const MIGRACION = path.resolve(
  process.cwd(),
  "prisma/migrations/20260925100250_cxp_v2_bloques_lote_historicos/migration.sql",
);
const RE_AVANCE = path.resolve(process.cwd(), "scripts/cxp/re-avance-v2.sql");

let disponible = false;
let motivoOmision = "BD local Postgres no disponible para las pruebas de bloques del lote histórico";
let userId = "";
let clienteId = "";
/** Base de números de DO de esta corrida (consecutivos a partir de ella: no chocan entre sí). */
const BASE_NUMERO = 700_000 + Math.floor(Math.random() * 1_000) * 1_000;
let numeroDo = 0;
const gruposCreados: string[] = [];

function leer(ruta: string): string {
  return readFileSync(ruta, "utf8").replace(/\r\n/g, "\n");
}

/** El UPDATE de pago_grupo que marca los bloques del lote (desde su SET hasta el cierre). */
function updateLote(sql: string): string {
  const inicio = sql.indexOf('UPDATE "pago_grupo" g\nSET "esHistorico" = true');
  expect(inicio, "no se encontró el UPDATE de los bloques del lote").toBeGreaterThanOrEqual(0);
  const cierre = "\n  );\n";
  const fin = sql.indexOf(cierre, inicio);
  expect(fin, "no se encontró el cierre del UPDATE").toBeGreaterThan(inicio);
  return sql.slice(inicio, fin + cierre.length);
}

async function correrMigracion(): Promise<number> {
  return prisma.$executeRawUnsafe(leer(MIGRACION));
}

async function limpiar() {
  const tramites = await prisma.tramiteDO.findMany({
    where: { comentarios: { startsWith: PREFIJO } },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);
  const pagos = await prisma.pagoTramite.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true, grupoPagoId: true },
  });
  const grupoIds = [
    ...new Set([...gruposCreados, ...pagos.map((p) => p.grupoPagoId).filter((g): g is string => g !== null)]),
  ];
  await prisma.auditLog.deleteMany({ where: { entidad: "PagoTramite", entidadId: { in: pagos.map((p) => p.id) } } });
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pagoGrupo.deleteMany({
    where: { OR: [{ id: { in: grupoIds } }, { concepto: { startsWith: PREFIJO } }] },
  });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { nit: { startsWith: PREFIJO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIJO } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivoOmision = "DATABASE_URL no está definida; se omiten las pruebas de bloques del lote histórico";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    await limpiar();
    const user = await prisma.user.create({
      data: { email: `${runId}@example.test`, name: "Vitest lote histórico", rol: Rol.ADMIN, emailVerified: true },
    });
    userId = user.id;
    const cliente = await prisma.cliente.create({
      data: { nombre: "CLIENTE LOTE HISTÓRICO", nit: `${PREFIJO}-${runId}`, tipo: TipoCliente.PROPIO },
    });
    clienteId = cliente.id;
    disponible = true;
  } catch (error) {
    motivoOmision = `BD local Postgres no disponible: ${error instanceof Error ? error.message : String(error)}`;
  }
});

afterAll(async () => {
  if (disponible) await limpiar();
  await prisma.$disconnect();
});

function exigirBd(ctx: { skip: (nota?: string) => void }) {
  if (!disponible) {
    ctx.skip(motivoOmision);
    throw new Error("omitido");
  }
}

async function crearDo(): Promise<string> {
  numeroDo += 1;
  const t = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ22-${String(numeroDo).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      numero: BASE_NUMERO + numeroDo,
      clienteId,
      creadoPorId: userId,
      comentarios: `${PREFIJO}:${runId}`,
    },
  });
  return t.id;
}

async function crearComprobante(tramiteId: string): Promise<string> {
  const doc = await prisma.documento.create({
    data: {
      tramiteId,
      categoria: CategoriaDocumento.COMPROBANTE_BANCARIO,
      nombreArchivo: "comprobante.pdf",
      storageKey: `vitest/lote-historico/${runId}/${randomUUID()}.pdf`,
      mimeType: "application/pdf",
      tamanoBytes: 10,
      subidoPorId: userId,
    },
  });
  return doc.id;
}

/** Cómo quedó registrado el pago en el AuditLog. */
type Auditoria =
  /** CREATE del lote con grupoPagoId null + UPDATE del lote que le pone el grupo (bloques del Excel). */
  | "LOTE_UPDATE"
  /** CREATE del lote que ya trae el grupoPagoId. */
  | "LOTE_CREATE"
  /** CREATE del lote, pero el UPDATE le puso OTRO grupoPagoId. */
  | "LOTE_OTRO_GRUPO"
  /** CREATE normal de la app (sin _lote). */
  | "APP";

interface PagoPlan {
  valor: bigint;
  auditoria: Auditoria;
  costoBancario?: bigint;
  conComprobante?: boolean;
}

interface BloquePlan {
  pagos: PagoPlan[];
  costoBancario?: bigint;
  conComprobante?: boolean;
  hashSolicitud?: string;
}

/** Bloque como lo dejó M3 (esHistorico = false, PRIMER_DO) con sus pagos y AuditLog. */
async function crearBloqueComoM3(plan: BloquePlan): Promise<string> {
  const grupoId = randomUUID();
  gruposCreados.push(grupoId);
  const tramiteIds: string[] = [];
  for (let i = 0; i < plan.pagos.length; i++) tramiteIds.push(await crearDo());
  const docGrupo = plan.conComprobante ? await crearComprobante(tramiteIds[0]) : null;
  await prisma.pagoGrupo.create({
    data: {
      id: grupoId,
      concepto: `${PREFIJO} PAGO EN BLOQUE (HISTÓRICO · CARTERA.xlsx)`,
      canalPago: CanalPago.PSE,
      fechaRealPago: new Date("2026-06-11T12:00:00Z"),
      documentoId: docGrupo,
      totalAplicado: plan.pagos.reduce((s, p) => s + p.valor, 0n),
      costoBancario: plan.costoBancario ?? 0n,
      costoAsumidoPor: "PRIMER_DO",
      esHistorico: false,
      hashSolicitud: plan.hashSolicitud ?? null,
    },
  });
  for (const [i, p] of plan.pagos.entries()) {
    const tramiteId = tramiteIds[i];
    const documentoId = p.conComprobante ? (docGrupo ?? (await crearComprobante(tramiteId))) : null;
    const pago = await prisma.pagoTramite.create({
      data: {
        tramiteId,
        concepto: `${PREFIJO} pago ${i + 1}`,
        valor: p.valor,
        canalPago: CanalPago.PSE,
        costoBancario: p.costoBancario ?? 0n,
        documentoId,
        grupoPagoId: grupoId,
        orden: 1,
      },
    });
    const base = { id: pago.id, valor: p.valor.toString(), canalPago: "PSE", documentoId };
    const lote = p.auditoria !== "APP";
    const gidEnCreate = p.auditoria === "LOTE_CREATE" || p.auditoria === "APP" ? grupoId : null;
    await prisma.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pago.id,
        accion: "CREATE",
        usuarioId: userId,
        tramiteId,
        despues: lote ? { ...base, _lote: LOTE, grupoPagoId: gidEnCreate } : { ...base, grupoPagoId: gidEnCreate },
      },
    });
    if (p.auditoria === "LOTE_UPDATE" || p.auditoria === "LOTE_OTRO_GRUPO") {
      await prisma.auditLog.create({
        data: {
          entidad: "PagoTramite",
          entidadId: pago.id,
          accion: "UPDATE",
          usuarioId: userId,
          tramiteId,
          despues: {
            _lote: LOTE,
            motivo: "pago en bloque de la cartera del proveedor (RF-05)",
            grupoPagoId: p.auditoria === "LOTE_UPDATE" ? grupoId : randomUUID(),
          },
        },
      });
    }
  }
  return grupoId;
}

async function grupo(id: string) {
  return prisma.pagoGrupo.findUniqueOrThrow({
    where: { id },
    select: {
      esHistorico: true,
      costoAsumidoPor: true,
      costoBancario: true,
      totalAplicado: true,
      estado: true,
      documentoId: true,
      updatedAt: true,
    },
  });
}

describe("Migración 20260925100250 — bloques de la carga histórica D0 = históricos", () => {
  it("marca el bloque del Excel (sin comprobante ni costo, todos sus pagos del lote) y deja intactos los que no cumplen; una segunda corrida no cambia nada", async (ctx) => {
    exigirBd(ctx);

    // Bloque del Excel de cartera: un pago con el grupo en el UPDATE del lote y otro en el CREATE.
    const excel = await crearBloqueComoM3({
      pagos: [
        { valor: 596_904n, auditoria: "LOTE_UPDATE" },
        { valor: 99_484n, auditoria: "LOTE_CREATE" },
      ],
    });
    // Mismo lote pero pagado con soporte (factura compartida entre dos DOs): no es del Excel.
    const conComprobante = await crearBloqueComoM3({
      conComprobante: true,
      pagos: [
        { valor: 262_750n, auditoria: "LOTE_CREATE", conComprobante: true },
        { valor: 262_750n, auditoria: "LOTE_CREATE", conComprobante: true },
      ],
    });
    // Cabecera sin comprobante, pero uno de sus pagos sí lo tiene.
    const pagoConComprobante = await crearBloqueComoM3({
      pagos: [
        { valor: 100_000n, auditoria: "LOTE_UPDATE" },
        { valor: 200_000n, auditoria: "LOTE_UPDATE", conComprobante: true },
      ],
    });
    // Bloque real de la app vieja (Camila): sin _lote y con costo bancario.
    const app = await crearBloqueComoM3({
      costoBancario: 7_300n,
      pagos: [
        { valor: 500_000n, auditoria: "APP", costoBancario: 7_300n },
        { valor: 500_000n, auditoria: "APP" },
      ],
    });
    // Mezcla: un pago del lote y otro de la app en el mismo grupo.
    const mixto = await crearBloqueComoM3({
      pagos: [
        { valor: 300_000n, auditoria: "LOTE_UPDATE" },
        { valor: 400_000n, auditoria: "APP" },
      ],
    });
    // El lote le asignó a ese pago OTRO grupo: la evidencia no es de este bloque.
    const otroGrupo = await crearBloqueComoM3({
      pagos: [
        { valor: 150_000n, auditoria: "LOTE_UPDATE" },
        { valor: 250_000n, auditoria: "LOTE_OTRO_GRUPO" },
      ],
    });
    // Sin costo en la cabecera pero con costo en un pago.
    const costoEnPago = await crearBloqueComoM3({
      pagos: [
        { valor: 110_000n, auditoria: "LOTE_UPDATE" },
        { valor: 120_000n, auditoria: "LOTE_UPDATE", costoBancario: 3_900n },
      ],
    });
    // Creado por la app v2 (siempre guarda hashSolicitud): nunca se toca.
    const appV2 = await crearBloqueComoM3({
      hashSolicitud: "a".repeat(64),
      pagos: [{ valor: 90_000n, auditoria: "LOTE_UPDATE" }],
    });

    const antes = await grupo(excel);
    const noTocar = [conComprobante, pagoConComprobante, app, mixto, otroGrupo, costoEnPago, appV2];
    const noTocarAntes = await Promise.all(noTocar.map((id) => grupo(id)));

    const primera = await correrMigracion();
    expect(primera).toBeGreaterThanOrEqual(1);

    const despues = await grupo(excel);
    expect(despues).toMatchObject({
      esHistorico: true,
      costoAsumidoPor: "GALCOMEX",
      costoBancario: 0n,
      totalAplicado: 696_388n,
      estado: "ACTIVO",
      documentoId: null,
    });
    expect(antes).toMatchObject({ esHistorico: false, costoAsumidoPor: "PRIMER_DO" });
    // No toca los pagos del bloque.
    const pagosExcel = await prisma.pagoTramite.findMany({
      where: { grupoPagoId: excel },
      select: { valor: true, costoBancario: true, documentoId: true },
      orderBy: { valor: "asc" },
    });
    expect(pagosExcel).toEqual([
      { valor: 99_484n, costoBancario: 0n, documentoId: null },
      { valor: 596_904n, costoBancario: 0n, documentoId: null },
    ]);

    const noTocarDespues = await Promise.all(noTocar.map((id) => grupo(id)));
    noTocar.forEach((id, i) => {
      expect({ id, ...noTocarDespues[i] }).toEqual({ id, ...noTocarAntes[i] });
      expect({ id, esHistorico: noTocarDespues[i].esHistorico }).toEqual({ id, esHistorico: false });
    });

    // Idempotente: la segunda corrida no encuentra nada (en toda la base).
    expect(await correrMigracion()).toBe(0);
    expect(await grupo(excel)).toEqual(despues);
  });

  it("re-avance-v2.sql (paso 8b) repite exactamente el UPDATE de la migración", () => {
    const migracion = updateLote(leer(MIGRACION));
    const reAvance = updateLote(leer(RE_AVANCE));
    expect(reAvance).toBe(migracion);
    expect(migracion).toContain(`'HIST-PLATA-%'`);
  });
});
