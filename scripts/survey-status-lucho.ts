/**
 * Barrido de validación (solo lectura) de los Excel de status de clientes de
 * Luis Martínez (socio Lucho). Parsea TODAS las hojas DO de los 11 archivos,
 * valida contra el layout conocido y emite:
 *   - un JSON maestro (para el import posterior)
 *   - un reporte de anomalías por consola
 *
 * Uso: npx tsx scripts/survey-status-lucho.ts [--out <master.json>]
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as XLSX from "xlsx";

import { listDoSheets, readGalcomexWorkbook } from "../src/lib/excel/galcomex-workbook";

const DOWNLOADS = "C:\\Users\\samue\\Downloads";

export const FILES: Array<{ file: string; clienteNombre: string }> = [
  { file: "PCC 2026.xlsm", clienteNombre: "PCC" },
  { file: "TEG MEK 2026.xlsm", clienteNombre: "TEG MEK" },
  { file: "GRUPO E PAPIS 2026 (2).xlsm", clienteNombre: "GRUPO E PAPIS" },
  { file: "FROZZEN 2026.xlsm", clienteNombre: "FROZZEN" },
  { file: "DINAGRICOLA 2026.xlsm", clienteNombre: "DINAGRICOLA" },
  { file: "FRITO GOLD 2026.xlsm", clienteNombre: "FRITO GOLD" },
  { file: "COLTRADE 2026.xlsm", clienteNombre: "COLTRADE" },
  { file: "COMALI 2026.xlsm", clienteNombre: "COMALI" },
  { file: "BERACA 2026.xlsm", clienteNombre: "BERACA" },
  { file: "COLFRAN 2026.xlsm", clienteNombre: "COLFRAN" },
  { file: "ANGIE GELVES 2026.xlsm", clienteNombre: "ANGIE GELVES" },
];

const RECAUDOS_VALIDOS = new Set(["BANCOLOMBIA", "OTROS BANCOS", "SUCURSAL", "CORRESPONSAL", "CAJERO"]);
const CANALES_VALIDOS = new Set(["TRANSF BANCOLOMBIA", "PSE", "TRANSF OTROS BANCOS"]);
const COSTOS_CONOCIDOS = new Set([
  "COMISIÓN GALCOMEX",
  "COMISION GALCOMEX",
  "IVA COMISIÓN",
  "IVA COMISION",
  "IMPUESTO 4X1000",
  "COSTOS BANCARIOS",
]);

export interface DoMaster {
  archivo: string;
  hoja: string;
  clienteNombre: string;
  consecutivo: string; // DO.XXXNN-NNNN
  ciudad: string;
  numero: number;
  factura: {
    numero: string | null; // BAQ-NNNNN real o null si BAQ-XXXXX/pendiente
    fecha: string | null; // ISO
    total: number | null;
    emitida: boolean;
  };
  anticipos: Array<{ fecha: string | null; monto: number; tipoRecaudo: string | null; costoRecaudo: number }>;
  anticipoTotal: number | null;
  pagos: Array<{ concepto: string; numSoporte: string | null; valor: number; canal: string | null; costo: number }>;
  costos: Array<{ concepto: string; nota: string | null; valor: number }>;
  comision: number | null;
  ivaComision: number | null;
  cuatroXmil: number | null;
  costosBancarios: number | null;
  saldoCliente: number | null;
  saldoLM: number | null;
  saldoLMFinal: number | null;
  anomalias: string[];
}

export interface Master {
  generadoEn: string;
  archivos: Array<{
    archivo: string;
    clienteNombre: string;
    dos: DoMaster[];
  }>;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function buildMaster(): Master {
  const master: Master = { generadoEn: new Date().toISOString(), archivos: [] };

  for (const { file, clienteNombre } of FILES) {
    const full = path.join(DOWNLOADS, file);
    const wb = XLSX.readFile(full, { cellDates: true });
    const doSheets = listDoSheets(wb);
    const dos: DoMaster[] = [];

    for (const sheet of doSheets) {
      const parsed = readGalcomexWorkbook(full, sheet);
      const t = parsed.target;
      const anomalias: string[] = [];

      const m = /^([A-Z]{3})(\d{2})-(\d{4})$/.exec(sheet);
      if (!m) {
        anomalias.push(`hoja no matchea patrón DO: ${sheet}`);
        continue;
      }
      const [, ciudad, , numeroStr] = m;

      // Cliente
      const clienteHoja = (t.metadata.customer ?? "").toUpperCase();
      if (clienteHoja && !clienteHoja.includes(clienteNombre.split(" ")[0])) {
        anomalias.push(`cliente en hoja ("${t.metadata.customer}") no parece "${clienteNombre}"`);
      }

      // DO number cross-check
      const doNumber = t.metadata.doNumber;
      if (doNumber && doNumber !== sheet) {
        anomalias.push(`A2 dice DO.${doNumber} pero la hoja es ${sheet}`);
      }

      // Anticipos
      const anticipos = t.advance.rows
        .filter((r) => num(r.amount) > 0)
        .map((r) => {
          const tipo = r.collectionType ? r.collectionType.toUpperCase().trim() : null;
          if (tipo && !RECAUDOS_VALIDOS.has(tipo)) anomalias.push(`recaudo desconocido: "${r.collectionType}"`);
          if (!r.date) anomalias.push(`anticipo de ${r.amount} sin fecha`);
          return { fecha: r.date, monto: num(r.amount), tipoRecaudo: tipo, costoRecaudo: num(r.bankCost) };
        });
      const sumaAnticipos = anticipos.reduce((s, a) => s + a.monto, 0);
      if (t.advance.total !== null && Math.abs(sumaAnticipos - t.advance.total) > 1) {
        anomalias.push(`Σanticipos ${sumaAnticipos} != TOTAL B20 ${t.advance.total}`);
      }

      // Pagos
      const pagos = t.payments.rows
        .filter((r) => num(r.amount) > 0 || (r.concept ?? "").trim().length > 0)
        .map((r) => {
          const canal = r.paymentType ? r.paymentType.toUpperCase().trim() : null;
          if (canal && !CANALES_VALIDOS.has(canal)) anomalias.push(`canal de pago desconocido: "${r.paymentType}" (pago "${r.concept}")`);
          if (num(r.amount) <= 0) anomalias.push(`pago "${r.concept}" con valor ${r.amount ?? "vacío"}`);
          if (num(r.amount) > 0 && !Number.isInteger(r.amount)) anomalias.push(`pago "${r.concept}" con decimales: ${r.amount}`);
          return {
            concepto: (r.concept ?? "Pago").trim(),
            numSoporte: r.invoiceReference ? String(r.invoiceReference).trim() : null,
            valor: num(r.amount),
            canal,
            costo: num(r.bankCost),
          };
        })
        .filter((p) => p.valor > 0);

      // Costos (comisión/iva/4x1000/costos bancarios)
      const costos = t.costs.rows.map((c) => {
        const concepto = (c.concept ?? "").toUpperCase().trim();
        if (concepto && !COSTOS_CONOCIDOS.has(concepto)) anomalias.push(`concepto de costo desconocido: "${c.concept}" = ${c.amount}`);
        return { concepto, nota: c.note, valor: num(c.amount) };
      });
      const byCosto = new Map(costos.map((c) => [c.concepto.replace("Ó", "O"), c.valor]));
      const comision = byCosto.get("COMISION GALCOMEX") ?? null;
      const ivaComision = byCosto.get("IVA COMISION") ?? null;
      const cuatroXmil = byCosto.get("IMPUESTO 4X1000") ?? null;
      const costosBancarios = byCosto.get("COSTOS BANCARIOS") ?? null;

      // Factura
      const numeroFactura = (t.metadata.invoiceNumber ?? "").trim();
      const emitida = /^BAQ-\d+$/i.test(numeroFactura) && num(t.totals.invoiceTotal) > 0;
      const fechaFactura = t.summary.invoiceDate.dateIso ?? null;
      if (emitida && !fechaFactura) anomalias.push(`factura ${numeroFactura} emitida pero sin fecha parseable (D58="${t.summary.invoiceDate.text}")`);

      if (anticipos.length === 0) anomalias.push("sin anticipos");
      if (emitida && comision === null) anomalias.push("factura emitida sin fila COMISIÓN GALCOMEX");

      dos.push({
        archivo: file,
        hoja: sheet,
        clienteNombre,
        consecutivo: `DO.${sheet}`,
        ciudad,
        numero: Number(numeroStr),
        factura: {
          numero: /^BAQ-\d+$/i.test(numeroFactura) ? numeroFactura.toUpperCase() : null,
          fecha: fechaFactura,
          total: t.totals.invoiceTotal,
          emitida,
        },
        anticipos,
        anticipoTotal: t.advance.total,
        pagos,
        costos: costos.filter((c) => c.concepto),
        comision,
        ivaComision,
        cuatroXmil,
        costosBancarios,
        saldoCliente: t.totals.clientBalance,
        saldoLM: t.totals.luisMartinezBalance,
        saldoLMFinal: t.totals.luisMartinezFinalBalance,
        anomalias,
      });
    }

    master.archivos.push({ archivo: file, clienteNombre, dos });
  }

  return master;
}

function main() {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(__dirname, "status-lucho-master.json");

  const master = buildMaster();

  let totalDos = 0;
  let totalAnomalias = 0;
  for (const a of master.archivos) {
    const emitidas = a.dos.filter((d) => d.factura.emitida).length;
    const conAnomalias = a.dos.filter((d) => d.anomalias.length > 0);
    totalDos += a.dos.length;
    console.log(`\n=== ${a.clienteNombre} (${a.archivo}) — ${a.dos.length} DOs, ${emitidas} facturados ===`);
    for (const d of conAnomalias) {
      totalAnomalias += d.anomalias.length;
      for (const an of d.anomalias) console.log(`  ⚠ ${d.hoja}: ${an}`);
    }
    if (conAnomalias.length === 0) console.log("  ✓ sin anomalías");
  }
  console.log(`\nTOTAL: ${totalDos} DOs en ${master.archivos.length} archivos, ${totalAnomalias} anomalías.`);

  fs.writeFileSync(outPath, JSON.stringify(master, null, 1));
  console.log(`JSON maestro: ${outPath}`);
}

const scriptName = process.argv[1] ? path.basename(process.argv[1]) : "";
if (scriptName.startsWith("survey-status-lucho")) {
  main();
}
