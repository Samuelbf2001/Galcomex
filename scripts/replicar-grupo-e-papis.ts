/**
 * Replicación end-to-end del DO real DO.BUN26-0026 (GRUPO E PAPIS) en la BD viva.
 *
 * Lee el Excel real con el parser (A3-T4), carga cliente → DO → anticipo → pagos
 * vía los servicios reales, genera el borrador con el motor (A1-T7/T8) y reconcilia
 * los valores calculados por el sistema contra los del Excel (tolerancia 0 pesos).
 *
 * Uso:  npx tsx scripts/replicar-grupo-e-papis.ts
 * Es idempotente: re-ejecutarlo borra y recarga el DO de replicación.
 */
import * as path from "node:path";

import { AgenciaAduanas, CanalPago, Ciudad, EstadoBorrador, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";

import { generarBorrador, transicionarBorrador } from "../src/lib/borradores/service";
import { prisma } from "../src/lib/db/prisma";
import { readGalcomexWorkbook } from "../src/lib/excel/galcomex-workbook";
import { crearPago } from "../src/lib/pagos/service";

const WORKBOOK = "C:\\Users\\samue\\Galcomex\\GRUPO E PAPIS 2026 (1).xlsm";
const SHEET = "BUN26-0026";
const CONSECUTIVO = "DO.BUN26-0026";
const NIT_REPLICA = "REPLICA-GRUPO-E-PAPIS";
const MARKER = "REPLICA:BUN26-0026";

/** Mapea el nombre de canal del Excel al enum CanalPago (3 valores). */
function mapCanalPago(excel: string | null): CanalPago {
  const v = (excel ?? "").toUpperCase().trim();
  if (v === "TRANSF BANCOLOMBIA") return CanalPago.TRANSF_BANCOLOMBIA;
  if (v === "TRANSF OTROS BANCOS") return CanalPago.TRANSF_OTROS_BANCOS;
  if (v === "PSE") return CanalPago.PSE;
  return CanalPago.TRANSF_BANCOLOMBIA;
}

/** Mapea el canal de RECAUDO del anticipo del Excel al enum TipoRecaudo. */
function mapTipoRecaudo(excel: string | null): TipoRecaudo {
  const v = (excel ?? "").toUpperCase().trim();
  if (v === "BANCOLOMBIA") return TipoRecaudo.BANCOLOMBIA;
  if (v === "OTROS BANCOS") return TipoRecaudo.OTROS_BANCOS;
  if (v === "SUCURSAL") return TipoRecaudo.SUCURSAL;
  if (v === "CORRESPONSAL") return TipoRecaudo.CORRESPONSAL;
  if (v === "CAJERO") return TipoRecaudo.CAJERO;
  return TipoRecaudo.BANCOLOMBIA;
}

function fmt(n: bigint): string {
  return new Intl.NumberFormat("es-CO").format(n);
}

async function limpiarReplicaPrevia() {
  const existing = await prisma.tramiteDO.findUnique({
    where: { consecutivo: CONSECUTIVO },
    select: { id: true },
  });
  if (existing) {
    const tramiteId = existing.id;
    const borradores = await prisma.borradorFactura.findMany({
      where: { tramiteId },
      select: { id: true },
    });
    const facturas = await prisma.factura.findMany({
      where: { borradorId: { in: borradores.map((b) => b.id) } },
      select: { id: true },
    });
    await prisma.pagoFactura.deleteMany({ where: { facturaId: { in: facturas.map((f) => f.id) } } });
    await prisma.factura.deleteMany({ where: { borradorId: { in: borradores.map((b) => b.id) } } });
    await prisma.borradorFactura.deleteMany({ where: { tramiteId } });
    await prisma.pagoTramite.deleteMany({ where: { tramiteId } });
    await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId } });
    await prisma.auditLog.deleteMany({ where: { tramiteId } });
    await prisma.estadoLog.deleteMany({ where: { tramiteId } });
    await prisma.tramiteDO.delete({ where: { id: tramiteId } });
  }
  await prisma.anticipo.deleteMany({ where: { soporteKey: MARKER } });
}

async function main() {
  console.log(`\n📥 Leyendo Excel real: ${path.basename(WORKBOOK)} → hoja ${SHEET}\n`);
  const parsed = readGalcomexWorkbook(WORKBOOK, SHEET);
  const t = parsed.target;

  const anticipoRow = t.advance.rows[0];
  const anticipoMonto = BigInt(Math.round(Number(anticipoRow.amount ?? 0)));
  const tipoRecaudo = mapTipoRecaudo(anticipoRow.collectionType);

  const pagos = t.payments.rows.map((r) => ({
    concepto: String(r.concept ?? "Pago"),
    numSoporte: r.invoiceReference ? String(r.invoiceReference) : null,
    valor: BigInt(Math.round(Number(r.amount ?? 0))),
    canalPago: mapCanalPago(r.paymentType),
  }));

  // Valores del Excel para reconciliar
  const costoPorConcepto = new Map(t.costs.rows.map((c) => [String(c.concept).toUpperCase(), BigInt(Math.round(Number(c.amount ?? 0)))]));
  const comisionExcel = costoPorConcepto.get("COMISIÓN GALCOMEX") ?? 200_000n;
  const ivaExcel = costoPorConcepto.get("IVA COMISIÓN") ?? 76_000n;
  const cuatroXmilExcel = costoPorConcepto.get("IMPUESTO 4X1000") ?? 0n;
  const costosExcel = costoPorConcepto.get("COSTOS BANCARIOS") ?? 0n;
  const totalFacturaExcel = BigInt(Math.round(Number(t.totals.invoiceTotal ?? 0)));
  const saldoClienteExcel = BigInt(Math.round(Number(t.totals.clientBalance ?? 0)));
  const saldoLMExcel = BigInt(Math.round(Number(t.totals.luisMartinezBalance ?? 0)));

  // ── Cargar en BD ──────────────────────────────────────────────────────────
  await limpiarReplicaPrevia();

  const admin = await prisma.user.findFirst({ where: { rol: Rol.ADMIN }, select: { id: true } });
  if (!admin) throw new Error("No hay usuario ADMIN en la BD (corre el seed).");

  const cliente = await prisma.cliente.upsert({
    where: { nit: NIT_REPLICA },
    update: { nombre: parsed.target.metadata.customer ?? "GRUPO E PAPIS" },
    create: {
      nombre: parsed.target.metadata.customer ?? "GRUPO E PAPIS",
      nit: NIT_REPLICA,
      tipo: TipoCliente.PROPIO,
    },
  });

  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: CONSECUTIVO,
      ciudad: Ciudad.BUN,
      anio: 2026,
      numero: 26,
      clienteId: cliente.id,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      doCliente: parsed.target.metadata.invoiceNumber,
      creadoPorId: admin.id,
      comentarios: MARKER,
    },
  });

  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: cliente.id,
      monto: anticipoMonto,
      fecha: anticipoRow.date ? new Date(anticipoRow.date) : new Date("2026-02-09"),
      tipoRecaudo,
      costoRecaudo: 1950n, // BANCOLOMBIA digital
      soporteKey: MARKER,
      verificadoBanco: true,
    },
  });

  await prisma.aplicacionAnticipo.create({
    data: { anticipoId: anticipo.id, tramiteId: tramite.id, montoAplicado: anticipoMonto },
  });

  for (const p of pagos) {
    await crearPago({
      tramiteId: tramite.id,
      concepto: p.concepto,
      numSoporte: p.numSoporte,
      valor: p.valor,
      canalPago: p.canalPago,
      usuarioId: admin.id,
    });
  }

  const borrador = await generarBorrador({
    tramiteId: tramite.id,
    comision: comisionExcel,
    ivaComision: ivaExcel,
    montoLM: saldoLMExcel, // monto atribuible a LM (en el Excel sale de la celda TOTAL FACTURA)
    usuarioId: admin.id,
  });

  // ── Avanzar el borrador hasta FACTURADO (replica el estado real del Excel:
  //    factura BAQ-18288 emitida, con sus saldos en cartera) ───────────────────
  const numFacturaSiigo = parsed.target.metadata.invoiceNumber ?? "BAQ-18288";
  const fechaFactura = new Date("2026-03-23"); // fecha de factura del Excel (R45)
  for (const estado of [
    EstadoBorrador.EN_REVISION,
    EstadoBorrador.APROBADO,
    EstadoBorrador.FACTURADO,
  ] as const) {
    const res = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: estado,
      usuarioId: admin.id,
      ...(estado === EstadoBorrador.FACTURADO ? { numFacturaSiigo, fechaFactura } : {}),
    });
    if (!res.ok) {
      console.warn(`⚠️  No se pudo transicionar a ${estado}: ${res.message}`);
      break;
    }
  }

  // ── Reconciliación ──────────────────────────────────────────────────────────
  const filas: Array<[string, bigint, bigint]> = [
    ["Anticipo aplicado", borrador.totalAnticipo, anticipoMonto],
    ["Total pagos", borrador.totalPagos, BigInt(Math.round(Number(parsed.target.payments.rows.reduce((s, r) => s + Number(r.amount ?? 0), 0))))],
    ["Costos bancarios", borrador.costosBancarios, costosExcel],
    ["Comisión", borrador.comision, comisionExcel],
    ["IVA comisión", borrador.ivaComision, ivaExcel],
    ["Impuesto 4x1000", borrador.impuesto4x1000, cuatroXmilExcel],
    ["TOTAL FACTURA", borrador.totalFactura, totalFacturaExcel],
    ["Saldo a favor cliente", borrador.saldoAFavorCliente, saldoClienteExcel],
    ["Saldo a favor LM", borrador.saldoAFavorLM, saldoLMExcel],
  ];

  console.log(`✅ Cargado en BD: cliente=${cliente.nombre}  DO=${tramite.consecutivo}  pagos=${pagos.length}  factura=${numFacturaSiigo} (FACTURADO)  → visible en Trámites, Facturación y Cartera\n`);
  console.log("RECONCILIACIÓN SISTEMA vs EXCEL (tolerancia 0 pesos)");
  console.log("─".repeat(72));
  console.log("Concepto".padEnd(26) + "Sistema".padStart(16) + "Excel".padStart(16) + "  OK");
  console.log("─".repeat(72));
  let todoOk = true;
  for (const [label, sistema, excel] of filas) {
    const ok = sistema === excel;
    if (!ok) todoOk = false;
    console.log(
      label.padEnd(26) + fmt(sistema).padStart(16) + fmt(excel).padStart(16) + "  " + (ok ? "✓" : "✗ DIFF"),
    );
  }
  console.log("─".repeat(72));
  console.log(todoOk ? "\n🎉 TODO CUADRA AL PESO — el sistema replica el Excel exactamente.\n" : "\n❌ HAY DISCREPANCIAS.\n");

  await prisma.$disconnect();
  if (!todoOk) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
