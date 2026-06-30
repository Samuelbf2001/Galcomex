import * as XLSX from "xlsx";

export const DEFAULT_DO_SHEET = "BUN26-0026";

const DO_SHEET_PATTERN = /^[A-Z]{3}\d{2}-\d{4}$/;

const LAYOUT = {
  advanceRows: { start: 5, end: 17, range: "A5:D17" },
  paymentRows: { start: 23, end: 37, range: "A23:F37" },
  costRows: { start: 38, end: 41, range: "A38:D41" },
  collectionFees: { start: 5, end: 10, range: "K5:L10" },
  paymentFees: { start: 12, end: 14, range: "K12:L14" },
  totals: {
    advanceTotal: "B20",
    advanceBankCostTotal: "D18",
    fourPerThousand: "D20",
    paymentBankCostTotal: "F38",
    invoiceTotal: "B46",
    clientBalance: "B47",
    luisMartinezBalance: "B51",
    luisMartinezFinalBalance: "B55",
  },
  summary: {
    doNumber: "A58",
    invoiceNumber: "B58",
    advanceTotal: "C58",
    invoiceDate: "D58",
    invoiceTotal: "E58",
    balanceAmount: "F58",
    balanceLabel: "G58",
    clientPaymentFlag: "H58",
    luisMartinezBalance: "I58",
    luisMartinezBalanceLabel: "J58",
    luisMartinezPaymentFlag: "K58",
  },
} as const;

type Workbook = XLSX.WorkBook;
type Worksheet = XLSX.WorkSheet;
type Cell = XLSX.CellObject | undefined;

export type ScalarCellValue = string | number | boolean | null;

export interface CellSnapshot {
  address: string;
  value: ScalarCellValue;
  text: string | null;
  formula: string | null;
  type: string | null;
  dateIso: string | null;
}

export interface AdvanceRow {
  row: number;
  date: string | null;
  amount: number | null;
  collectionType: string | null;
  bankCost: number | null;
  cells: Record<"date" | "amount" | "collectionType" | "bankCost", CellSnapshot>;
}

export interface PaymentRow {
  row: number;
  concept: string | null;
  invoiceReference: string | null;
  amount: number | null;
  balanceAfter: number | null;
  paymentType: string | null;
  bankCost: number | null;
  cells: Record<
    "concept" | "invoiceReference" | "amount" | "balanceAfter" | "paymentType" | "bankCost",
    CellSnapshot
  >;
}

export interface CostRow {
  row: number;
  concept: string | null;
  note: string | null;
  amount: number | null;
  balanceAfter: number | null;
  cells: Record<"concept" | "note" | "amount" | "balanceAfter", CellSnapshot>;
}

export interface FeeRule {
  row: number;
  type: string;
  cost: number;
  cells: Record<"type" | "cost", CellSnapshot>;
}

export interface ParsedDoSheet {
  sheetName: string;
  worksheetRange: string | null;
  layout: typeof LAYOUT;
  metadata: {
    customer: string | null;
    doNumber: string | null;
    invoiceNumber: string | null;
    cells: Record<"customer" | "doNumber" | "invoiceNumber", CellSnapshot>;
  };
  advance: {
    rows: AdvanceRow[];
    total: number | null;
    bankCostTotal: number | null;
    fourPerThousand: number | null;
    cells: Record<"total" | "bankCostTotal" | "fourPerThousand", CellSnapshot>;
  };
  payments: {
    rows: PaymentRow[];
    amountTotal: number;
    bankCostTotal: number | null;
    cells: Record<"bankCostTotal", CellSnapshot>;
  };
  costs: {
    rows: CostRow[];
  };
  feeRules: {
    collection: FeeRule[];
    payment: FeeRule[];
  };
  totals: {
    invoiceTotal: number | null;
    clientBalance: number | null;
    luisMartinezBalance: number | null;
    luisMartinezFinalBalance: number | null;
    cells: Record<
      "invoiceTotal" | "clientBalance" | "luisMartinezBalance" | "luisMartinezFinalBalance",
      CellSnapshot
    >;
  };
  summary: Record<keyof typeof LAYOUT.summary, CellSnapshot>;
}

export interface ParsedWorkbook {
  source: {
    filePath: string;
    sheetCount: number;
    doSheetCount: number;
    targetSheet: string;
    dryRun: true;
  };
  doSheets: string[];
  target: ParsedDoSheet;
}

export function readGalcomexWorkbook(filePath: string, sheetName = DEFAULT_DO_SHEET): ParsedWorkbook {
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,
    cellFormula: true,
    cellNF: false,
    cellStyles: false,
  });

  const doSheets = listDoSheets(workbook);

  return {
    source: {
      filePath,
      sheetCount: workbook.SheetNames.length,
      doSheetCount: doSheets.length,
      targetSheet: sheetName,
      dryRun: true,
    },
    doSheets,
    target: parseDoSheetFromWorkbook(workbook, sheetName),
  };
}

/**
 * Parsea una hoja DO de un workbook ya cargado en memoria (p.ej. desde un
 * archivo subido vía `XLSX.read(buffer, …)`). Misma lógica que usa
 * `readGalcomexWorkbook` tras `XLSX.readFile`; permite importar sin tocar disco.
 */
export function parseDoSheetFromWorkbook(
  workbook: Workbook,
  sheetName: string,
): ParsedDoSheet {
  const worksheet = workbook.Sheets[sheetName];

  if (!worksheet) {
    const doSheets = listDoSheets(workbook);
    throw new Error(
      `Sheet "${sheetName}" was not found. Available DO sheets: ${doSheets.join(", ") || "(none)"}`,
    );
  }

  return parseDoSheet(worksheet, sheetName);
}

export function listDoSheets(workbook: Workbook): string[] {
  return workbook.SheetNames.filter((name) => DO_SHEET_PATTERN.test(name));
}

export function summarizeParsedWorkbook(parsed: ParsedWorkbook): string {
  const target = parsed.target;
  const lines = [
    `Archivo: ${parsed.source.filePath}`,
    `Hojas DO: ${parsed.source.doSheetCount} (${parsed.doSheets.join(", ")})`,
    `Hoja objetivo: ${target.sheetName} (${target.worksheetRange ?? "sin rango"})`,
    `Cliente: ${target.metadata.customer ?? "(vacio)"}`,
    `DO: ${target.metadata.doNumber ?? "(vacio)"}`,
    `Factura: ${target.metadata.invoiceNumber ?? "(vacio)"}`,
    `Anticipos: ${target.advance.rows.length} fila(s), total ${formatNumber(target.advance.total)}`,
    `Pagos: ${target.payments.rows.length} fila(s), total ${formatNumber(target.payments.amountTotal)}`,
    `Costos: ${target.costs.rows.length} fila(s)`,
    `Total factura: ${formatNumber(target.totals.invoiceTotal)}`,
    `Saldo cliente: ${target.summary.balanceLabel.value ?? "(sin etiqueta)"} ${formatNumber(
      target.totals.clientBalance,
    )}`,
    `Saldo LM final: ${formatNumber(target.totals.luisMartinezFinalBalance)}`,
  ];

  return lines.join("\n");
}

function parseDoSheet(worksheet: Worksheet, sheetName: string): ParsedDoSheet {
  const advanceRows = parseAdvanceRows(worksheet);
  const paymentRows = parsePaymentRows(worksheet);
  const costRows = parseCostRows(worksheet);

  return {
    sheetName,
    worksheetRange: worksheet["!ref"] ?? null,
    layout: LAYOUT,
    metadata: {
      customer: textAt(worksheet, "B1"),
      doNumber: normalizeDoNumber(textAt(worksheet, "A2")),
      invoiceNumber: textAt(worksheet, "B2"),
      cells: {
        customer: snapshot(worksheet, "B1"),
        doNumber: snapshot(worksheet, "A2"),
        invoiceNumber: snapshot(worksheet, "B2"),
      },
    },
    advance: {
      rows: advanceRows,
      total: numberAt(worksheet, LAYOUT.totals.advanceTotal),
      bankCostTotal: numberAt(worksheet, LAYOUT.totals.advanceBankCostTotal),
      fourPerThousand: numberAt(worksheet, LAYOUT.totals.fourPerThousand),
      cells: {
        total: snapshot(worksheet, LAYOUT.totals.advanceTotal),
        bankCostTotal: snapshot(worksheet, LAYOUT.totals.advanceBankCostTotal),
        fourPerThousand: snapshot(worksheet, LAYOUT.totals.fourPerThousand),
      },
    },
    payments: {
      rows: paymentRows,
      amountTotal: sumNumbers(paymentRows.map((row) => row.amount)),
      bankCostTotal: numberAt(worksheet, LAYOUT.totals.paymentBankCostTotal),
      cells: {
        bankCostTotal: snapshot(worksheet, LAYOUT.totals.paymentBankCostTotal),
      },
    },
    costs: {
      rows: costRows,
    },
    feeRules: {
      collection: parseFeeRules(worksheet, LAYOUT.collectionFees.start, LAYOUT.collectionFees.end),
      payment: parseFeeRules(worksheet, LAYOUT.paymentFees.start, LAYOUT.paymentFees.end),
    },
    totals: {
      invoiceTotal: numberAt(worksheet, LAYOUT.totals.invoiceTotal),
      clientBalance: numberAt(worksheet, LAYOUT.totals.clientBalance),
      luisMartinezBalance: numberAt(worksheet, LAYOUT.totals.luisMartinezBalance),
      luisMartinezFinalBalance: numberAt(worksheet, LAYOUT.totals.luisMartinezFinalBalance),
      cells: {
        invoiceTotal: snapshot(worksheet, LAYOUT.totals.invoiceTotal),
        clientBalance: snapshot(worksheet, LAYOUT.totals.clientBalance),
        luisMartinezBalance: snapshot(worksheet, LAYOUT.totals.luisMartinezBalance),
        luisMartinezFinalBalance: snapshot(worksheet, LAYOUT.totals.luisMartinezFinalBalance),
      },
    },
    summary: snapshotMap(worksheet, LAYOUT.summary),
  };
}

function parseAdvanceRows(worksheet: Worksheet): AdvanceRow[] {
  const rows: AdvanceRow[] = [];

  for (let row = LAYOUT.advanceRows.start; row <= LAYOUT.advanceRows.end; row += 1) {
    const record: AdvanceRow = {
      row,
      date: dateAt(worksheet, `A${row}`),
      amount: numberAt(worksheet, `B${row}`),
      collectionType: textAt(worksheet, `C${row}`),
      bankCost: numberAt(worksheet, `D${row}`),
      cells: {
        date: snapshot(worksheet, `A${row}`),
        amount: snapshot(worksheet, `B${row}`),
        collectionType: snapshot(worksheet, `C${row}`),
        bankCost: snapshot(worksheet, `D${row}`),
      },
    };

    if (record.date || isNonZero(record.amount) || record.collectionType || isNonZero(record.bankCost)) {
      rows.push(record);
    }
  }

  return rows;
}

function parsePaymentRows(worksheet: Worksheet): PaymentRow[] {
  const rows: PaymentRow[] = [];

  for (let row = LAYOUT.paymentRows.start; row <= LAYOUT.paymentRows.end; row += 1) {
    const record: PaymentRow = {
      row,
      concept: textAt(worksheet, `A${row}`),
      invoiceReference: textAt(worksheet, `B${row}`),
      amount: numberAt(worksheet, `C${row}`),
      balanceAfter: numberAt(worksheet, `D${row}`),
      paymentType: textAt(worksheet, `E${row}`),
      bankCost: numberAt(worksheet, `F${row}`),
      cells: {
        concept: snapshot(worksheet, `A${row}`),
        invoiceReference: snapshot(worksheet, `B${row}`),
        amount: snapshot(worksheet, `C${row}`),
        balanceAfter: snapshot(worksheet, `D${row}`),
        paymentType: snapshot(worksheet, `E${row}`),
        bankCost: snapshot(worksheet, `F${row}`),
      },
    };

    if (
      record.concept ||
      record.invoiceReference ||
      isNonZero(record.amount) ||
      record.paymentType ||
      isNonZero(record.bankCost)
    ) {
      rows.push(record);
    }
  }

  return rows;
}

function parseCostRows(worksheet: Worksheet): CostRow[] {
  const rows: CostRow[] = [];

  for (let row = LAYOUT.costRows.start; row <= LAYOUT.costRows.end; row += 1) {
    const record: CostRow = {
      row,
      concept: textAt(worksheet, `A${row}`),
      note: textAt(worksheet, `B${row}`),
      amount: numberAt(worksheet, `C${row}`),
      balanceAfter: numberAt(worksheet, `D${row}`),
      cells: {
        concept: snapshot(worksheet, `A${row}`),
        note: snapshot(worksheet, `B${row}`),
        amount: snapshot(worksheet, `C${row}`),
        balanceAfter: snapshot(worksheet, `D${row}`),
      },
    };

    if (record.concept || record.note || isNonZero(record.amount) || isNonZero(record.balanceAfter)) {
      rows.push(record);
    }
  }

  return rows;
}

function parseFeeRules(worksheet: Worksheet, start: number, end: number): FeeRule[] {
  const rows: FeeRule[] = [];

  for (let row = start; row <= end; row += 1) {
    const type = textAt(worksheet, `K${row}`);
    const cost = numberAt(worksheet, `L${row}`);

    if (type && cost !== null) {
      rows.push({
        row,
        type,
        cost,
        cells: {
          type: snapshot(worksheet, `K${row}`),
          cost: snapshot(worksheet, `L${row}`),
        },
      });
    }
  }

  return rows;
}

function snapshotMap<T extends Record<string, string>>(
  worksheet: Worksheet,
  addresses: T,
): Record<keyof T, CellSnapshot> {
  return Object.fromEntries(
    Object.entries(addresses).map(([key, address]) => [key, snapshot(worksheet, address)]),
  ) as Record<keyof T, CellSnapshot>;
}

function snapshot(worksheet: Worksheet, address: string): CellSnapshot {
  const cell = worksheet[address] as Cell;
  const value = cellValue(cell);

  return {
    address,
    value,
    text: cleanText(cell?.w),
    formula: cleanText(cell?.f),
    type: cell?.t ?? null,
    dateIso: dateFromCell(cell),
  };
}

function textAt(worksheet: Worksheet, address: string): string | null {
  const value = snapshot(worksheet, address).value;
  return typeof value === "string" ? value : null;
}

function numberAt(worksheet: Worksheet, address: string): number | null {
  const value = snapshot(worksheet, address).value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateAt(worksheet: Worksheet, address: string): string | null {
  return snapshot(worksheet, address).dateIso;
}

function cellValue(cell: Cell): ScalarCellValue {
  if (!cell) {
    return null;
  }

  if (cell.t === "d") {
    return dateFromCell(cell);
  }

  if (typeof cell.v === "string") {
    return cleanText(cell.v);
  }

  if (typeof cell.v === "number" || typeof cell.v === "boolean") {
    return cell.v;
  }

  return null;
}

function dateFromCell(cell: Cell): string | null {
  if (!cell) {
    return null;
  }

  if (cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
    return cell.v.toISOString().slice(0, 10);
  }

  if (typeof cell.v === "number") {
    const parsed = XLSX.SSF.parse_date_code(cell.v);
    if (parsed) {
      return [
        String(parsed.y).padStart(4, "0"),
        String(parsed.m).padStart(2, "0"),
        String(parsed.d).padStart(2, "0"),
      ].join("-");
    }
  }

  return null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeDoNumber(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.replace(/^DO\./i, "");
}

function isNonZero(value: number | null): boolean {
  return value !== null && value !== 0;
}

function sumNumbers(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function formatNumber(value: number | null): string {
  return value === null ? "(vacio)" : new Intl.NumberFormat("es-CO").format(value);
}
