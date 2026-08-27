/**
 * Importa los 11 workbooks de status de clientes de Luis Martínez (socio LM)
 * a la BD de Galcomex, usando el motor probado `importarWorkbookGrupoEPapis`.
 *
 * - Hojas FACTURADAS  → motor completo (DO + anticipos + pagos + borrador →
 *   FACTURADO, valores del Excel como fuente de verdad).
 * - Hojas EN CURSO (factura BAQ-XXXXX / sin total) → DO en EN_TRAMITE con
 *   anticipos + pagos (sin borrador), para seguir trabajándolas en la app.
 * - Idempotente: los consecutivos existentes se saltan (YA_EXISTIA).
 *
 * Uso (dentro del contenedor):
 *   npx tsx scripts/importar-status-lucho.ts --dir /app/import-lucho --dry
 *   npx tsx scripts/importar-status-lucho.ts --dir /app/import-lucho
 */
import * as path from "node:path";

import { EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import * as XLSX from "xlsx";

import { prisma } from "../src/lib/db/prisma";
import {
  importarWorkbookGrupoEPapis,
  mapCanalPago,
  mapTipoRecaudo,
  type ResultadoHoja,
} from "../src/lib/import/grupo-e-papis";
import {
  listDoSheets,
  parseDoSheetFromWorkbook,
} from "../src/lib/excel/galcomex-workbook";
import { crearPago } from "../src/lib/pagos/service";

const ARCHIVOS: Array<{ file: string; nombre: string; nit: string }> = [
  { file: "PCC 2026.xlsm", nombre: "PCC", nit: "LM-PCC" },
  { file: "TEG MEK 2026.xlsm", nombre: "TEG MEK", nit: "LM-TEG-MEK" },
  { file: "GRUPO E PAPIS 2026 (2).xlsm", nombre: "Grupo E Papis", nit: "901056434" },
  { file: "FROZZEN 2026.xlsm", nombre: "FROZZEN", nit: "LM-FROZZEN" },
  { file: "DINAGRICOLA 2026.xlsm", nombre: "DINAGRICOLA", nit: "LM-DINAGRICOLA" },
  { file: "FRITO GOLD 2026.xlsm", nombre: "FRITO GOLD", nit: "LM-FRITO-GOLD" },
  { file: "COLTRADE 2026.xlsm", nombre: "COLTRADE", nit: "LM-COLTRADE" },
  { file: "COMALI 2026.xlsm", nombre: "COMALI", nit: "LM-COMALI" },
  { file: "BERACA 2026.xlsm", nombre: "BERACA", nit: "LM-BERACA" },
  { file: "COLFRAN 2026.xlsm", nombre: "COLFRAN", nit: "LM-COLFRAN" },
  { file: "ANGIE GELVES 2026.xlsm", nombre: "ANGIE GELVES", nit: "LM-ANGIE-GELVES" },
];

const SHEET_NAME_PATTERN = /^([A-Z]{3})(\d{2})-(\d{4})$/;

function toBigInt(value: number | null | undefined): bigint {
  return BigInt(Math.round(Number(value ?? 0)));
}

function fmt(n: bigint | number): string {
  return new Intl.NumberFormat("es-CO").format(Number(n));
}

/** Importa una hoja NO facturada como DO en curso (EN_TRAMITE), con anticipos y pagos. */
async function importarHojaEnCurso(
  workbook: XLSX.WorkBook,
  sheetName: string,
  clienteId: string,
  usuarioId: string,
  dryRun: boolean,
): Promise<{ estado: string; motivo?: string; anticipos: number; pagos: number }> {
  const consecutivo = `DO.${sheetName}`;
  const match = SHEET_NAME_PATTERN.exec(sheetName);
  if (!match) return { estado: "ERROR", motivo: "nombre de hoja inválido", anticipos: 0, pagos: 0 };
  const [, prefijo, aa, nnnn] = match;

  const existente = await prisma.tramiteDO.findUnique({ where: { consecutivo }, select: { id: true } });
  if (existente) return { estado: "YA_EXISTIA", anticipos: 0, pagos: 0 };

  const parsed = parseDoSheetFromWorkbook(workbook, sheetName);

  const anticipoRows = parsed.advance.rows
    .filter((r) => toBigInt(r.amount) > 0n)
    .map((r) => ({
      monto: toBigInt(r.amount),
      fecha: r.date ? new Date(r.date) : null,
      tipoRecaudo: mapTipoRecaudo(r.collectionType),
      costoRecaudo: r.collectionType ? toBigInt(r.bankCost) : 0n,
      conRecaudo: Boolean(r.collectionType),
    }));

  const pagos = parsed.payments.rows
    .filter((r) => toBigInt(r.amount) > 0n)
    .map((r) => ({
      concepto: String(r.concept ?? "Pago"),
      numSoporte: r.invoiceReference ? String(r.invoiceReference) : null,
      valor: toBigInt(r.amount),
      canalPago: mapCanalPago(r.paymentType),
    }));

  if (dryRun) return { estado: "EN_CURSO(dry)", anticipos: anticipoRows.length, pagos: pagos.length };

  // Fecha fallback para anticipos sin fecha: la del primer anticipo con fecha, o hoy.
  const fechaFallback = anticipoRows.find((r) => r.fecha)?.fecha ?? new Date();

  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo,
      ciudad: prefijo as never,
      anio: 2000 + Number(aa),
      numero: Number(nnnn),
      clienteId,
      agenciaAduanas: "COLDEX" as never,
      estado: EstadoTramite.EN_TRAMITE,
      creadoPorId: usuarioId,
      comentarios: `IMPORT:${consecutivo} (en curso)`,
    },
  });

  for (const row of anticipoRows) {
    const anticipo = await prisma.anticipo.create({
      data: {
        clienteId,
        monto: row.monto,
        fecha: row.fecha ?? fechaFallback,
        tipoRecaudo: row.tipoRecaudo,
        costoRecaudo: row.conRecaudo ? row.costoRecaudo : 0n,
        soporteKey: `IMPORT:${consecutivo}`,
        verificadoBanco: true,
      },
    });
    await prisma.aplicacionAnticipo.create({
      data: { anticipoId: anticipo.id, tramiteId: tramite.id, montoAplicado: row.monto },
    });
  }

  for (const p of pagos) {
    await crearPago({
      tramiteId: tramite.id,
      concepto: p.concepto,
      numSoporte: p.numSoporte,
      valor: p.valor,
      canalPago: p.canalPago,
      usuarioId,
    });
  }

  return { estado: "EN_CURSO", anticipos: anticipoRows.length, pagos: pagos.length };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : "/app/import-lucho";

  const admin = await prisma.user.findFirst({
    where: { rol: Rol.ADMIN },
    select: { id: true, email: true },
  });
  if (!admin) throw new Error("No hay usuario ADMIN");
  console.log(`Usuario import: ${admin.email}  |  modo: ${dryRun ? "DRY-RUN (no escribe)" : "REAL"}\n`);

  const totales = { importadas: 0, enCurso: 0, yaExistian: 0, errores: 0, overrides: 0 };
  const detalleErrores: string[] = [];
  const detalleYaExistian: string[] = [];
  const detalleOverrides: string[] = [];

  for (const { file, nombre, nit } of ARCHIVOS) {
    const full = path.join(dir, file);
    const workbook = XLSX.readFile(full, { cellDates: true, cellFormula: true });
    const hojas = listDoSheets(workbook);

    let cliente = await prisma.cliente.findUnique({ where: { nit } });
    if (!cliente && !dryRun) {
      cliente = await prisma.cliente.create({
        data: { nombre, nit, tipo: TipoCliente.SOCIO_LM, manejaAnticipo: true },
      });
    }
    const clienteId = cliente?.id ?? "(dry-run-sin-cliente)";
    console.log(`\n══ ${nombre} (${file}) — ${hojas.length} hojas DO — cliente ${cliente ? (cliente.nombre + " " + cliente.nit) : "NUEVO " + nit} ══`);

    if (!cliente && dryRun) {
      console.log("   (dry-run: cliente aún no existe, se crearía SOCIO_LM)");
    }

    // 1) Hojas facturadas → motor probado
    const res = await importarWorkbookGrupoEPapis({
      workbook,
      clienteId,
      usuarioId: admin.id,
      dryRun,
    });

    // 2) Hojas OMITIDAS (no facturadas) → DO en curso
    const omitidas = res.hojas.filter((h: ResultadoHoja) => h.estado === "OMITIDO");
    for (const h of omitidas) {
      try {
        const r = await importarHojaEnCurso(workbook, h.sheetName, clienteId, admin.id, dryRun);
        if (r.estado.startsWith("EN_CURSO")) {
          totales.enCurso += 1;
          console.log(`   ▸ ${h.sheetName}: EN CURSO (${r.anticipos} anticipos, ${r.pagos} pagos, sin factura)`);
        } else if (r.estado === "YA_EXISTIA") {
          totales.yaExistian += 1;
          detalleYaExistian.push(`${nombre} ${h.sheetName} (en curso)`);
        } else {
          totales.errores += 1;
          detalleErrores.push(`${nombre} ${h.sheetName}: ${r.motivo}`);
        }
      } catch (e) {
        totales.errores += 1;
        detalleErrores.push(`${nombre} ${h.sheetName}: ${e instanceof Error ? e.message : e}`);
      }
    }

    for (const h of res.hojas) {
      if (h.estado === "IMPORTADO") {
        totales.importadas += 1;
        if (h.requirioOverride) {
          totales.overrides += 1;
          const diffs = h.reconciliacion
            .filter((f) => !f.ok)
            .map((f) => `${f.concepto}: motor ${fmt(BigInt(f.sistema))} vs excel ${fmt(BigInt(f.excel))}`)
            .join("; ");
          detalleOverrides.push(`${nombre} ${h.sheetName} → ${diffs}`);
        }
      } else if (h.estado === "YA_EXISTIA") {
        totales.yaExistian += 1;
        detalleYaExistian.push(`${nombre} ${h.sheetName}`);
      } else if (h.estado === "ERROR") {
        totales.errores += 1;
        detalleErrores.push(`${nombre} ${h.sheetName}: ${h.motivo}`);
      }
    }

    const imp = res.hojas.filter((h) => h.estado === "IMPORTADO").length;
    console.log(`   Facturadas importadas: ${imp} | ya existían: ${res.hojas.filter((h) => h.estado === "YA_EXISTIA").length} | errores: ${res.errores}`);
  }

  console.log(`\n${"═".repeat(70)}\nRESUMEN ${dryRun ? "(DRY-RUN)" : ""}`);
  console.log(`  Facturadas importadas : ${totales.importadas}`);
  console.log(`  En curso importadas   : ${totales.enCurso}`);
  console.log(`  Ya existían (saltadas): ${totales.yaExistian}`);
  console.log(`  Errores               : ${totales.errores}`);
  console.log(`  Con override Excel    : ${totales.overrides} (se persistió el valor del Excel)`);

  if (detalleYaExistian.length) {
    console.log(`\nYA EXISTÍAN:`);
    for (const d of detalleYaExistian) console.log(`  - ${d}`);
  }
  if (detalleErrores.length) {
    console.log(`\nERRORES:`);
    for (const d of detalleErrores) console.log(`  - ${d}`);
  }
  if (detalleOverrides.length) {
    console.log(`\nOVERRIDES (motor ≠ Excel, quedó el Excel):`);
    for (const d of detalleOverrides) console.log(`  - ${d}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
