/**
 * siigo-xlsx.ts — Export XLSX para SIIGO (A3-T3)
 *
 * Genera buffers XLSX para:
 * 1. construirBorradorXlsx  — borrador de factura: líneas + bloque de totales
 * 2. construirRelacionFacturasXlsx — relación anual de facturas por cliente
 *
 * Reglas:
 * - Función pura sobre DTOs; NO accede a BD.
 * - Montos BigInt → Number SOLO en celdas numéricas (COP enteros < 2^53, safe).
 * - Celdas de valor usan XLSX tipo "n" (número), nunca texto formateado.
 */

import * as XLSX from "xlsx";

// ─── Tipos de entrada ─────────────────────────────────────────────────────────

export interface LineaRevisionDto {
  concepto: string;
  numSoporte: string | null;
  valor: bigint;
  orden: number;
}

export interface BorradorDto {
  id: string;
  numFacturaSiigo: string | null;
  tramite?: {
    consecutivo: string;
    cliente?: {
      nombre: string;
    } | null;
  } | null;
  lineasRevision: LineaRevisionDto[];
  comision: bigint;
  ivaComision: bigint;
  impuesto4x1000: bigint;
  costosBancarios: bigint;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
}

export interface FacturaCarteraDto {
  id: string;
  numSiigo: string;
  fecha: Date;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
  fechaPagoCliente: Date | null;
  fechaPagoLM: Date | null;
  borrador?: {
    tramiteId: string;
    tramite?: {
      consecutivo: string;
    } | null;
  } | null;
}

export interface CarteraClienteDto {
  facturas: FacturaCarteraDto[];
  cruceCliente: bigint;
  cruceLM: bigint;
  totalFacturas: number;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/** Crea una celda numérica explícita (type "n"). Conversión BigInt→number segura (COP < 2^53). */
function numCell(value: bigint): XLSX.CellObject {
  return { t: "n", v: Number(value) };
}

/** Crea una celda de texto (type "s"). */
function strCell(value: string): XLSX.CellObject {
  return { t: "s", v: value };
}

/** Crea una celda de fecha (type "d"). */
function dateCell(value: Date): XLSX.CellObject {
  return { t: "d", v: value };
}

/**
 * Convierte un array de filas (arrays de CellObject) en una WorkSheet.
 * Se construye manualmente para garantizar type "n" en celdas numéricas
 * (XLSX.utils.aoa_to_sheet trata CellObject como valores primitivos).
 */
function rowsToSheet(rows: XLSX.CellObject[][]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};

  let maxCol = 0;
  rows.forEach((row, rowIdx) => {
    if (row.length > maxCol) maxCol = row.length;
    row.forEach((cell, colIdx) => {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
      ws[addr] = cell;
    });
  });

  ws["!ref"] = XLSX.utils.encode_range(
    { r: 0, c: 0 },
    { r: Math.max(rows.length - 1, 0), c: Math.max(maxCol - 1, 0) },
  );

  return ws;
}

// ─── 1. Borrador de factura ───────────────────────────────────────────────────

/**
 * Genera un Buffer XLSX con la estructura del borrador que Camila copia a SIIGO.
 *
 * Layout de la hoja "Borrador":
 *   Fila 1  : DO  | <consecutivo>  | Cliente | <nombre>
 *   Fila 2  : Factura SIIGO | <num>  | ""  | ""
 *   Fila 3  : (vacía)
 *   Fila 4  : Concepto | Nº Soporte | Valor   ← cabecera columnas
 *   Filas 5…: una fila por línea de revisión
 *   (vacía)
 *   Bloque de totales (Concepto | "" | Valor):
 *     Comisión Galcomex
 *     IVA comisión
 *     Impuesto 4x1000
 *     Costos bancarios
 *     TOTAL FACTURA
 *     Saldo a favor/cargo cliente
 *     Saldo a favor/cargo LM
 */
export function construirBorradorXlsx(borrador: BorradorDto): Buffer {
  const wb = XLSX.utils.book_new();

  const consecutivo = borrador.tramite?.consecutivo ?? borrador.id;
  const clienteNombre = borrador.tramite?.cliente?.nombre ?? "";
  const numSiigo = borrador.numFacturaSiigo ?? "";

  // Encabezado meta
  const headerRows: XLSX.CellObject[][] = [
    [strCell("DO"), strCell(consecutivo), strCell("Cliente"), strCell(clienteNombre)],
    [strCell("Factura SIIGO"), strCell(numSiigo), strCell(""), strCell("")],
    [], // separador
    [strCell("Concepto"), strCell("Nº Soporte"), strCell("Valor")],
  ];

  // Líneas de revisión ordenadas
  const lineasOrdenadas = [...borrador.lineasRevision].sort((a, b) => a.orden - b.orden);
  const lineasRows: XLSX.CellObject[][] = lineasOrdenadas.map((linea) => [
    strCell(linea.concepto),
    strCell(linea.numSoporte ?? ""),
    numCell(linea.valor),
  ]);

  // Bloque de totales
  const etiquetaSaldoCliente =
    borrador.saldoAFavorCliente > 0n ? "Saldo a favor cliente" : "Saldo a cargo cliente";
  const valorSaldoCliente =
    borrador.saldoAFavorCliente > 0n ? borrador.saldoAFavorCliente : borrador.saldoACargoCliente;

  const etiquetaSaldoLM =
    borrador.saldoAFavorLM > 0n ? "Saldo a favor LM" : "Saldo a cargo LM";
  const valorSaldoLM =
    borrador.saldoAFavorLM > 0n ? borrador.saldoAFavorLM : borrador.saldoACargoLM;

  const totalesRows: XLSX.CellObject[][] = [
    [strCell("Comisión Galcomex"), strCell(""), numCell(borrador.comision)],
    [strCell("IVA comisión"), strCell(""), numCell(borrador.ivaComision)],
    [strCell("Impuesto 4x1000"), strCell(""), numCell(borrador.impuesto4x1000)],
    [strCell("Costos bancarios"), strCell(""), numCell(borrador.costosBancarios)],
    [strCell("TOTAL FACTURA"), strCell(""), numCell(borrador.totalFactura)],
    [strCell(etiquetaSaldoCliente), strCell(""), numCell(valorSaldoCliente)],
    [strCell(etiquetaSaldoLM), strCell(""), numCell(valorSaldoLM)],
  ];

  const allRows: XLSX.CellObject[][] = [
    ...headerRows,
    ...lineasRows,
    [], // separador antes de totales
    ...totalesRows,
  ];

  const ws = rowsToSheet(allRows);
  XLSX.utils.book_append_sheet(wb, ws, "Borrador");

  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer);
}

// ─── 2. Relación de facturas ──────────────────────────────────────────────────

/**
 * Genera un Buffer XLSX con la relación anual de facturas por cliente (RELACION FACT).
 *
 * Layout de la hoja "Relacion Facturas":
 *   Fila 1  : cabecera de columnas
 *   Filas 2…: una fila por factura
 *   (vacía)
 *   Filas de cruce:
 *     Total a cargo/favor cliente
 *     Total a cargo/favor LM
 *
 * Columnas:
 *   DO | Factura SIIGO | Fecha | Total Factura | Saldo a favor cliente |
 *   Saldo a cargo cliente | A cargo / A favor | Saldo a favor LM | Saldo a cargo LM | Cruce LM
 */
export function construirRelacionFacturasXlsx(cartera: CarteraClienteDto): Buffer {
  const wb = XLSX.utils.book_new();

  const cabecera: XLSX.CellObject[] = [
    strCell("DO"),
    strCell("Factura SIIGO"),
    strCell("Fecha"),
    strCell("Total Factura"),
    strCell("Saldo a favor cliente"),
    strCell("Saldo a cargo cliente"),
    strCell("A cargo / A favor"),
    strCell("Saldo a favor LM"),
    strCell("Saldo a cargo LM"),
    strCell("Cruce LM"),
  ];

  const facturaRows: XLSX.CellObject[][] = cartera.facturas.map((f) => {
    const doConsecutivo = f.borrador?.tramite?.consecutivo ?? "";
    const etiquetaCruce =
      f.saldoACargoCliente > 0n ? "A cargo" : f.saldoAFavorCliente > 0n ? "A favor" : "Saldado";

    return [
      strCell(doConsecutivo),
      strCell(f.numSiigo),
      dateCell(f.fecha),
      numCell(f.totalFactura),
      numCell(f.saldoAFavorCliente),
      numCell(f.saldoACargoCliente),
      strCell(etiquetaCruce),
      numCell(f.saldoAFavorLM),
      numCell(f.saldoACargoLM),
      numCell(f.saldoACargoLM - f.saldoAFavorLM),
    ];
  });

  // Totales de cruce
  // cruceCliente > 0 → cliente debe a Galcomex
  const cruceTotalClienteAbs =
    cartera.cruceCliente >= 0n ? cartera.cruceCliente : -cartera.cruceCliente;
  const etiquetaCruceCliente =
    cartera.cruceCliente > 0n
      ? "Total a cargo cliente"
      : cartera.cruceCliente < 0n
        ? "Total a favor cliente"
        : "Saldado";

  const cruceLMTotalAbs =
    cartera.cruceLM >= 0n ? cartera.cruceLM : -cartera.cruceLM;
  const etiquetaCruceLM =
    cartera.cruceLM > 0n
      ? "Total a cargo LM"
      : cartera.cruceLM < 0n
        ? "Total a favor LM"
        : "Saldado LM";

  const totalesRows: XLSX.CellObject[][] = [
    [
      strCell(etiquetaCruceCliente),
      strCell(""), strCell(""), strCell(""), strCell(""), strCell(""),
      numCell(cruceTotalClienteAbs),
      strCell(""), strCell(""), strCell(""),
    ],
    [
      strCell(etiquetaCruceLM),
      strCell(""), strCell(""), strCell(""), strCell(""), strCell(""),
      strCell(""), strCell(""), strCell(""),
      numCell(cruceLMTotalAbs),
    ],
  ];

  const allRows: XLSX.CellObject[][] = [
    cabecera,
    ...facturaRows,
    [], // separador
    ...totalesRows,
  ];

  const ws = rowsToSheet(allRows);
  XLSX.utils.book_append_sheet(wb, ws, "Relacion Facturas");

  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer);
}

// ─── Utilidades exportadas ────────────────────────────────────────────────────

/** Nombre de archivo para Content-Disposition */
export function nombreArchivoXlsx(
  tipo: "borrador" | "cartera",
  id: string,
  numSiigo?: string | null,
): string {
  if (tipo === "borrador") {
    return `borrador-${numSiigo ?? id}.xlsx`;
  }
  return `cartera-${id}.xlsx`;
}

/** Content-Type para respuestas XLSX */
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
