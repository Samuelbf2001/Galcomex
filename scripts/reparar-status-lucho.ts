/**
 * Repara los 7 DOs del import de status de Lucho que fallaron por la regla
 * "sin anticipo no hay pagos": en el Excel estos DOs legítimamente NO tienen
 * anticipo (los pagos salieron del fondo global del cliente). Se crea un
 * anticipo de $0 aplicado (marcado) para satisfacer la regla, se cargan los
 * pagos y, si la hoja está facturada, se genera el borrador con los valores
 * del Excel y se avanza a FACTURADO.
 *
 * Uso: npx tsx scripts/reparar-status-lucho.ts --dir /app/import-lucho
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { EstadoBorrador, EstadoTramite, Rol, TipoRecaudo } from "@prisma/client";
import * as XLSX from "xlsx";

import { generarBorrador, transicionarBorrador } from "../src/lib/borradores/service";
import { prisma } from "../src/lib/db/prisma";
import { parseDoSheetFromWorkbook } from "../src/lib/excel/galcomex-workbook";
import { mapCanalPago } from "../src/lib/import/grupo-e-papis";
import { crearPago } from "../src/lib/pagos/service";
import { transitionTramite } from "../src/lib/tramites/service";

// El build ESM de xlsx no detecta `fs` automáticamente; sin esto
// `XLSX.readFile` falla con "Cannot access file" aunque el archivo exista.
XLSX.set_fs(fs);

const CASOS: Array<{ file: string; sheet: string; facturada: boolean }> = [
  { file: "FROZZEN 2026.xlsm", sheet: "BUN26-0203", facturada: true },
  { file: "FROZZEN 2026.xlsm", sheet: "CTG26-0202", facturada: true },
  { file: "FROZZEN 2026.xlsm", sheet: "CTG26-0213", facturada: true },
  { file: "FROZZEN 2026.xlsm", sheet: "CTG26-0207", facturada: false },
  { file: "FROZZEN 2026.xlsm", sheet: "CTG26-0222", facturada: false },
  { file: "FROZZEN 2026.xlsm", sheet: "CTG26-0225", facturada: false },
  { file: "COMALI 2026.xlsm", sheet: "CTG26-0034", facturada: true },
];

function toBigInt(value: number | null | undefined): bigint {
  return BigInt(Math.round(Number(value ?? 0)));
}

async function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : "/app/import-lucho";

  const admin = await prisma.user.findFirst({ where: { rol: Rol.ADMIN }, select: { id: true } });
  if (!admin) throw new Error("No hay ADMIN");

  for (const caso of CASOS) {
    const consecutivo = `DO.${caso.sheet}`;
    console.log(`\n── ${consecutivo} (${caso.file}) ──`);
    try {
      const tramite = await prisma.tramiteDO.findUnique({
        where: { consecutivo },
        select: { id: true, clienteId: true, estado: true },
      });
      if (!tramite) {
        console.log("   NO EXISTE el trámite — saltado");
        continue;
      }

      const yaPagos = await prisma.pagoTramite.count({ where: { tramiteId: tramite.id } });
      if (yaPagos > 0) {
        console.log(`   ya tiene ${yaPagos} pagos — saltado (ya reparado)`);
        continue;
      }

      const wb = XLSX.readFile(path.join(dir, caso.file), { cellDates: true, cellFormula: true });
      const parsed = parseDoSheetFromWorkbook(wb, caso.sheet);

      // 1) Anticipo $0 aplicado (satisface la regla; refleja "sin anticipo en Excel")
      const yaAplicacion = await prisma.aplicacionAnticipo.findFirst({ where: { tramiteId: tramite.id } });
      if (!yaAplicacion) {
        const anticipo = await prisma.anticipo.create({
          data: {
            clienteId: tramite.clienteId,
            monto: 0n,
            fecha: new Date("2026-01-01"),
            tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
            costoRecaudo: 0n,
            soporteKey: `IMPORT:${consecutivo} (sin anticipo en Excel)`,
            verificadoBanco: true,
          },
        });
        await prisma.aplicacionAnticipo.create({
          data: { anticipoId: anticipo.id, tramiteId: tramite.id, montoAplicado: 0n },
        });
        console.log("   anticipo $0 aplicado (marcador)");
      }

      // 2) Pagos
      const pagos = parsed.payments.rows
        .filter((r) => toBigInt(r.amount) > 0n)
        .map((r) => ({
          concepto: String(r.concept ?? "Pago"),
          numSoporte: r.invoiceReference ? String(r.invoiceReference) : null,
          valor: toBigInt(r.amount),
          canalPago: mapCanalPago(r.paymentType),
        }));
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
      console.log(`   ${pagos.length} pagos creados`);

      if (!caso.facturada) {
        console.log("   en curso → queda EN_TRAMITE con sus pagos");
        continue;
      }

      // 3) Borrador con valores del Excel + FACTURADO
      const costoPorConcepto = new Map(
        parsed.costs.rows.map((c) => [String(c.concept ?? "").toUpperCase(), toBigInt(c.amount)]),
      );
      const comision = costoPorConcepto.get("COMISIÓN GALCOMEX") ?? 0n;
      const ivaComision = costoPorConcepto.get("IVA COMISIÓN") ?? 0n;
      const impuesto4x1000Excel = costoPorConcepto.get("IMPUESTO 4X1000") ?? 0n;
      const costosBancariosExcel = costoPorConcepto.get("COSTOS BANCARIOS") ?? 0n;
      const montoLM = toBigInt(parsed.totals.luisMartinezBalance);
      const totalFacturaExcel = toBigInt(parsed.totals.invoiceTotal);
      const saldoCliente = toBigInt(parsed.totals.clientBalance);

      const borrador = await generarBorrador({
        tramiteId: tramite.id,
        comision,
        ivaComision,
        montoLM,
        usuarioId: admin.id,
      });

      await prisma.borradorFactura.update({
        where: { id: borrador.id },
        data: {
          costosBancarios: costosBancariosExcel,
          impuesto4x1000: impuesto4x1000Excel,
          totalFactura: totalFacturaExcel,
          saldoAFavorCliente: saldoCliente > 0n ? saldoCliente : 0n,
          saldoACargoCliente: saldoCliente < 0n ? -saldoCliente : 0n,
          saldoAFavorLM: montoLM,
        },
      });

      const numFacturaSiigo = parsed.metadata.invoiceNumber ?? consecutivo;
      const fechaIso = parsed.summary.invoiceDate?.dateIso;
      const fechaFactura = fechaIso ? new Date(fechaIso) : new Date();
      for (const estado of [EstadoBorrador.EN_REVISION, EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO] as const) {
        const res = await transicionarBorrador({
          borradorId: borrador.id,
          nuevoEstado: estado,
          usuarioId: admin.id,
          ...(estado === EstadoBorrador.FACTURADO ? { numFacturaSiigo, fechaFactura } : {}),
        });
        if (!res.ok) throw new Error(`transición ${estado}: ${res.message}`);
      }
      const tr = await transitionTramite(tramite.id, EstadoTramite.FACTURADO, admin.id);
      if (!tr.ok) throw new Error(`DO → FACTURADO: ${tr.message}`);
      console.log(`   FACTURADO ${numFacturaSiigo} — total ${totalFacturaExcel}`);
    } catch (e) {
      console.log(`   ✗ ERROR: ${e instanceof Error ? e.message : e}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
