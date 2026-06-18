/**
 * Parser del borrador de venta de Lucho (Luis Martínez, socio de Galcomex).
 *
 * Lee el formato .xls que Lucho entrega por correo con los datos del DO:
 * cliente, factura BAQ, fecha, líneas de terceros (pagos a proveedores) e
 * ingresos operacionales (comisión), retenciones y totales.
 *
 * El parser es PURO filesystem → DTO. No toca la BD.
 *
 * Uso:
 *   import { parseBorradorLucho } from "@/lib/excel/borrador-lucho";
 *   const parseado = parseBorradorLucho("ruta/al/archivo.xls");
 */

import * as XLSX from "xlsx";

// ─── Tipos exportados ─────────────────────────────────────────────────────────

/** Referencia extraída del concepto de una línea de terceros. */
export interface ReferenciaFactura {
  /** Texto de la referencia tal como aparece en el concepto (ej. "FESP7291332"). */
  numFactura: string;
}

/** Una línea de "INGRESOS RECIBIDOS PARA TERCEROS". */
export interface LineaTercero {
  /** Texto completo del concepto (col C). */
  concepto: string;
  /** Valor en COP (entero). */
  valor: bigint;
  /** true si la celda tiene fondo azul 99CCFF → pagado por PSE desde cuenta Galcomex. */
  esPse: boolean;
  /** true si es la línea de impuesto 4x1000. */
  es4x1000: boolean;
  /** Nombre del proveedor inferido heurísticamente del concepto (texto antes de la referencia). */
  proveedorNombre: string | null;
  /** Referencias de factura de proveedor extraídas del concepto. Vacío si no hay. */
  referencias: ReferenciaFactura[];
  /** Número de fila en la hoja (para trazabilidad). */
  fila: number;
}

/** Una línea de "INGRESOS OPERACIONALES". */
export interface LineaOperacional {
  concepto: string;
  valor: bigint;
  fila: number;
}

/** Una línea de retención (RETE IVA / RETE FTE / RETE ICA). */
export interface LineaRetencion {
  concepto: string;
  valor: bigint;
  fila: number;
}

/** Información del DO extraída de la cabecera. */
export interface DoInfo {
  /** Consecutivo sin prefijo DO (ej. "CTG26-0118" o "26-0113"). */
  consecutivo: string;
  /** Ciudad extraída (ej. "CTG"). null si el formato no incluye ciudad. */
  ciudad: string | null;
  /** Año en 2 dígitos (ej. "26"). */
  anio: string;
  /** Número de DO (ej. "0118"). */
  numero: string;
  /** Texto completo del DO tal como aparece en la hoja. */
  textoOriginal: string;
}

/** DTO completo devuelto por parseBorradorLucho. */
export interface BorradorLuchoParseado {
  /** Ruta del archivo. */
  filePath: string;
  /** Nombre de la hoja leída. */
  sheetName: string;

  // Cabecera
  /** Nombre del cliente. */
  clienteNombre: string;
  /** NIT normalizado (ej. "901056434-2"). */
  clienteNit: string;
  /** Número de factura de venta (ej. "BAQ-18453"). */
  numFactura: string;
  /** Fecha de la factura en formato ISO YYYY-MM-DD. */
  fecha: string;

  /** Información del DO. */
  do: DoInfo;

  // Cuerpo
  /** Líneas de terceros (incluyendo la de 4x1000 si existe). */
  terceros: LineaTercero[];
  /** Suma total de terceros (incluyendo 4x1000). */
  totalTerceros: bigint;

  /** Líneas operacionales (comisión desglosada). */
  operacionales: LineaOperacional[];
  /** Suma de operacionales. */
  totalOperacionales: bigint;

  /** IVA de la comisión. */
  iva: bigint;

  /** Líneas de retención. */
  retenciones: LineaRetencion[];
  /** Suma total de retenciones. */
  totalRetenciones: bigint;

  /** Total factura según el Excel. */
  totalFactura: bigint;
  /** Anticipo según el Excel. */
  anticipo: bigint;
  /**
   * Saldo según el Excel.
   * Negativo en la celda del Excel = a favor del cliente.
   * Aquí se guarda como valor positivo cuando es a favor (saldo a favor > 0).
   */
  saldoAFavor: bigint;
}

/** Discrepancia encontrada por reconciliar(). */
export interface Discrepancia {
  campo: string;
  esperado: bigint;
  calculado: bigint;
  diferencia: bigint;
}

/** Resultado de reconciliar(): discrepancias o arreglo vacío si todo cuadra. */
export type ResultadoReconciliacion = Discrepancia[];

// ─── Regex de extracción ──────────────────────────────────────────────────────

/**
 * Extrae el consecutivo del DO del texto de la cabecera.
 * Formatos conocidos:
 *   "DO CTG26-0118. 1X40..."        → ciudad=CTG, anio=26, numero=0118
 *   "DO.26-0113 IM096..."           → ciudad=null, anio=26, numero=0113
 *   "DO. CTG26-0118"                → con punto + espacio
 *   "DO.BUN26-0026"                 → sin espacio
 */
const DO_REGEX = /DO\.?\s?(?:([A-Z]{3}))?(\d{2})-(\d{3,4})/i;

/**
 * Extrae referencias de factura de proveedor del concepto.
 * Patrones cubiertos:
 *   FACT No.FESP7291332
 *   FACT Nos.FESP7291332/FESP7291333
 *   FACT.FESP7291332
 *   FACT.AAAR-8092
 *   RECIBO No.RP-R2607938
 *   CUENTA DE COBRO No.26-0070
 *   FACT 1003982615
 */
const REF_PATTERNS: RegExp[] = [
  // "FACT Nos.X/Y" — múltiples referencias separadas por /
  /FACT\s+Nos?\.\s*([A-Z0-9/_.-]+)/gi,
  // "FACT No.X" — una referencia
  /FACT\s+No\.\s*([A-Z0-9/_.-]+)/gi,
  // "FACT.X" — sin "No."
  /FACT\.\s*([A-Z0-9_.-]+)/gi,
  // "FACT X" — solo número
  /FACT\s+(\d{6,})/gi,
  // "RECIBO No.X"
  /RECIBO\s+No\.\s*([A-Z0-9/_.-]+)/gi,
  // "CUENTA DE COBRO No.X"
  /CUENTA\s+DE\s+COBRO\s+No\.\s*([A-Z0-9/_.-]+)/gi,
];

// ─── Helpers internos ─────────────────────────────────────────────────────────

type Worksheet = XLSX.WorkSheet;
type Cell = XLSX.CellObject | undefined;

function getCell(ws: Worksheet, address: string): Cell {
  return ws[address] as Cell;
}

function cellText(ws: Worksheet, address: string): string | null {
  const cell = getCell(ws, address);
  if (!cell) return null;
  const raw = cell.w ?? (cell.v !== undefined && cell.v !== null ? String(cell.v) : null);
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cellNumber(ws: Worksheet, address: string): number | null {
  const cell = getCell(ws, address);
  if (!cell) return null;
  if (typeof cell.v === "number" && Number.isFinite(cell.v)) return cell.v;
  // Formatted value may contain $ and commas — try parsing
  // El valor numérico viene siempre en cell.v (xlsx ya lo parsea); el texto
  // formateado (cell.w, formato colombiano $1.234.567) no se necesita.
  return null;
}

function toCOP(value: number | null): bigint {
  if (value === null || !Number.isFinite(value)) return 0n;
  return BigInt(Math.round(value));
}

function cellFgColor(cell: Cell): string | null {
  if (!cell) return null;
  // With cellStyles:true, fgColor is under cell.s
  const s = (cell as XLSX.CellObject & { s?: { fgColor?: { rgb?: string } } }).s;
  return s?.fgColor?.rgb ?? null;
}

function is99CCFF(cell: Cell): boolean {
  const rgb = cellFgColor(cell);
  if (!rgb) return false;
  return rgb.toUpperCase() === "FF99CCFF" || rgb.toUpperCase() === "99CCFF";
}

/** Extrae referencias de proveedor del texto del concepto. */
function extraerReferencias(concepto: string): ReferenciaFactura[] {
  const refs: ReferenciaFactura[] = [];
  const found = new Set<string>();

  for (const pattern of REF_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(concepto)) !== null) {
      // Split by / for "FACT Nos.X/Y"
      const parts = m[1].split("/");
      for (const part of parts) {
        const clean = part.trim().replace(/\.$/, "");
        if (clean.length > 0 && !found.has(clean)) {
          found.add(clean);
          refs.push({ numFactura: clean });
        }
      }
    }
  }

  return refs;
}

/** Infiere el nombre del proveedor como el texto antes de la primera referencia. */
function inferirProveedor(concepto: string, referencias: ReferenciaFactura[]): string | null {
  if (referencias.length === 0) return null;

  // Try to find where the first reference key word appears
  const keywordPatterns = [
    /FACT\s+Nos?\./i,
    /FACT\./i,
    /FACT\s+\d/i,
    /RECIBO\s+No\./i,
    /CUENTA\s+DE\s+COBRO\s+No\./i,
  ];

  let earliestIdx = concepto.length;
  for (const p of keywordPatterns) {
    const m = p.exec(concepto);
    if (m && m.index < earliestIdx) {
      earliestIdx = m.index;
    }
  }

  if (earliestIdx === concepto.length) return null;

  const before = concepto
    .substring(0, earliestIdx)
    .replace(/[.\-,]+$/, "")
    .trim();

  return before.length > 0 ? before : null;
}

/** Detecta si una línea es de 4x1000. */
function es4x1000Line(concepto: string): boolean {
  const upper = concepto.toUpperCase();
  return upper.includes("4X1000") || upper.includes("4 X 1000") || upper.includes("DECRETO 2331");
}

/** Detecta si una línea es de retención. */
function esRetencionLine(concepto: string): boolean {
  const upper = concepto.toUpperCase();
  return (
    upper.includes("RETE IVA") ||
    upper.includes("RETE FTE") ||
    upper.includes("RETE ICA") ||
    upper.includes("RETEFUENTE") ||
    upper.includes("RETEICA")
  );
}

/**
 * Normaliza un NIT extraído del Excel.
 * Formatos de entrada:
 *   "NIT. 901056434-2." → "901056434-2"
 *   "NIT. 802,009,663-3" → "802009663-3"
 *   "802,009,663-3" → "802009663-3"
 */
function normalizarNit(raw: string): string {
  return raw
    .replace(/NIT\.?\s*/gi, "")  // Remove "NIT. " prefix
    .replace(/,/g, "")            // Remove thousands separators
    .replace(/\s+/g, "")          // Remove spaces
    .replace(/\.+$/, "")          // Remove trailing dots
    .trim();
}

// ─── Parser principal ─────────────────────────────────────────────────────────

/**
 * Parsea un archivo .xls de borrador de Lucho.
 *
 * @param filePath  Ruta absoluta al archivo .xls
 * @param sheetName Nombre de la hoja (default "Hoja1")
 */
export function parseBorradorLucho(
  filePath: string,
  sheetName = "Hoja1",
): BorradorLuchoParseado {
  const wb = XLSX.readFile(filePath, {
    cellStyles: true,
    cellDates: true,
    cellFormula: false,
    cellNF: false,
  });

  const ws = wb.Sheets[sheetName];
  if (!ws) {
    const available = wb.SheetNames.join(", ");
    throw new Error(
      `Hoja "${sheetName}" no encontrada. Hojas disponibles: ${available}`,
    );
  }

  const ref = ws["!ref"];
  if (!ref) throw new Error(`La hoja "${sheetName}" está vacía.`);

  const range = XLSX.utils.decode_range(ref);
  const maxRow = range.e.r + 1; // 1-based

  // ── Detectar layout: archivo 1 tiene cliente en C9, archivo 2 en C8 ─────────
  // Buscamos la fila con "Señor (es):"
  let clienteRow: number | null = null;
  for (let r = 8; r <= 12; r++) {
    const b = cellText(ws, `B${r}`);
    if (b && b.includes("Señor")) {
      clienteRow = r;
      break;
    }
  }
  if (clienteRow === null) {
    throw new Error("No se encontró la fila de cliente (buscando 'Señor (es):' en col B)");
  }

  // ── Cliente nombre: col C de la fila clienteRow ───────────────────────────
  const clienteNombreRaw = cellText(ws, `C${clienteRow}`) ?? "";
  const clienteNombre = clienteNombreRaw.trim();

  // ── NIT: fila siguiente, col B ────────────────────────────────────────────
  // En ambos archivos el NIT está en B(clienteRow+1) como "NIT. XXXXXX-X. CEL..."
  const nitRowText = cellText(ws, `B${clienteRow + 1}`) ?? "";
  // Extract NIT pattern: digits-digit, possibly with commas
  const nitMatch = nitRowText.match(/NIT\.?\s*([\d,]+[-][\d]+)/i);
  const clienteNit = nitMatch ? normalizarNit(nitMatch[1]) : normalizarNit(nitRowText.split(" ")[0]);

  // ── Número de factura: col J de la fila clienteRow ───────────────────────
  // Also check clienteRow+1 in case layout shifts
  let numFactura = cellText(ws, `J${clienteRow}`) ?? cellText(ws, `J${clienteRow + 1}`) ?? "";
  if (!numFactura.startsWith("BAQ-")) {
    // fallback: scan I col area
    for (let r = clienteRow; r <= clienteRow + 3; r++) {
      const v = cellText(ws, `J${r}`);
      if (v && /^BAQ-\d+/.test(v)) {
        numFactura = v;
        break;
      }
    }
  }

  // ── Fecha: D, G, H cols of the date row (after clienteRow) ───────────────
  // Layout: FECHA label on clienteRow (col F), D/M/A headers on clienteRow+1,
  // actual values (dia, mes, anio) on clienteRow+2.
  // Fallback: scan for a row where F, G, H all have numeric year-range values.
  let fechaRow: number | null = null;
  for (let r = clienteRow; r <= clienteRow + 4; r++) {
    const fLabel = cellText(ws, `F${r}`);
    if (fLabel && fLabel.toUpperCase().includes("FECHA")) {
      // Values are 2 rows below the FECHA label (skip the D/M/A header row)
      fechaRow = r + 2;
      break;
    }
    // Direct fallback: F=numeric dia, G=numeric mes, H=numeric año > 2000
    const fVal = cellNumber(ws, `F${r}`);
    const gVal = cellNumber(ws, `G${r}`);
    const hVal = cellNumber(ws, `H${r}`);
    if (fVal !== null && gVal !== null && hVal !== null && hVal > 2000) {
      fechaRow = r;
      break;
    }
  }

  let fecha = "2026-01-01";
  if (fechaRow !== null) {
    // Date cells may be stored as strings ("13", "5", "2026") or numbers
    const diaRaw = cellNumber(ws, `F${fechaRow}`) ?? parseInt(cellText(ws, `F${fechaRow}`) ?? "", 10);
    const mesRaw = cellNumber(ws, `G${fechaRow}`) ?? parseInt(cellText(ws, `G${fechaRow}`) ?? "", 10);
    const anioRaw = cellNumber(ws, `H${fechaRow}`) ?? parseInt(cellText(ws, `H${fechaRow}`) ?? "", 10);
    if (!isNaN(diaRaw) && !isNaN(mesRaw) && !isNaN(anioRaw) && anioRaw > 2000) {
      fecha = [
        String(Math.round(anioRaw)).padStart(4, "0"),
        String(Math.round(mesRaw)).padStart(2, "0"),
        String(Math.round(diaRaw)).padStart(2, "0"),
      ].join("-");
    }
  }

  // ── DO: scan rows B15-B20 for DO pattern ─────────────────────────────────
  let doInfo: DoInfo | null = null;
  for (let r = 14; r <= 25; r++) {
    const txt = cellText(ws, `B${r}`);
    if (txt) {
      const m = DO_REGEX.exec(txt);
      if (m) {
        const ciudad = m[1] ? m[1].toUpperCase() : null;
        const anio = m[2];
        const numero = m[3];
        const consecutivo = ciudad ? `${ciudad}${anio}-${numero}` : `${anio}-${numero}`;
        doInfo = {
          consecutivo,
          ciudad,
          anio,
          numero,
          textoOriginal: txt,
        };
        break;
      }
    }
  }
  if (!doInfo) {
    throw new Error("No se encontró el consecutivo del DO en las primeras filas del cuerpo.");
  }

  // ── Secciones: escanear toda la hoja ─────────────────────────────────────
  // Buscar cabeceras de sección y las celdas de totales
  let inicioTerceros: number | null = null;
  let finTerceros: number | null = null;
  let inicioOperacionales: number | null = null;
  let filaIva: number | null = null;
  const filaRetenciones: number[] = [];
  let filaTotalTerceros: number | null = null;
  let filaTotalFactura: number | null = null;

  for (let r = 14; r <= maxRow; r++) {
    const c = cellText(ws, `C${r}`);
    const f = cellText(ws, `F${r}`);
    const b = cellText(ws, `B${r}`);

    if (c) {
      const cu = c.toUpperCase();
      if (cu.includes("INGRESOS RECIBIDOS PARA TERCEROS") && inicioTerceros === null) {
        inicioTerceros = r + 1;
      }
      if (cu.includes("TOTAL INGRESOS RECIBIDOS PARA TERCEROS") && filaTotalTerceros === null) {
        filaTotalTerceros = r;
        finTerceros = r - 1;
      }
      if (cu.includes("INGRESOS OPERACIONALES") && inicioOperacionales === null) {
        inicioOperacionales = r + 1;
      }
      // Detect IVA line: patterns like "19% IVA.", "16% IVA.", "% IVA"
      // Must contain "% IVA" (with percentage sign) to avoid matching words
      // like "OPERATIVA" or "REATIVA" which embed "IVA" as a substring.
      if (/%\s*IVA/.test(cu) && filaIva === null) {
        filaIva = r;
      }
      if (cu.includes("MENOS") || esRetencionLine(c)) {
        // start of retenciones section or individual retencion line
      }
    }
    // Retenciones can be in col D (label) or col C
    const d = cellText(ws, `D${r}`);
    if (d && esRetencionLine(d)) {
      filaRetenciones.push(r);
    }
    if (c && esRetencionLine(c)) {
      filaRetenciones.push(r);
    }

    // Total factura in col F, Anticipo in col F
    if (f) {
      const fu = f.toUpperCase();
      if ((fu.includes("TOTAL FACTURA") || fu.includes("TOTAL  FACTURA")) && filaTotalFactura === null) {
        filaTotalFactura = r;
      }
    }
    if (b) {
      const bu = b.toUpperCase();
      if ((bu.includes("TOTAL FACTURA") || bu.includes("TOTAL  FACTURA")) && filaTotalFactura === null) {
        filaTotalFactura = r;
      }
    }
  }

  // ── Extraer terceros ──────────────────────────────────────────────────────
  const terceros: LineaTercero[] = [];
  if (inicioTerceros !== null) {
    const fin = finTerceros ?? (inicioOperacionales ? inicioOperacionales - 2 : maxRow);
    for (let r = inicioTerceros; r <= fin; r++) {
      const concepto = cellText(ws, `C${r}`);
      if (!concepto) continue;
      const valorNum = cellNumber(ws, `I${r}`);
      if (valorNum === null || valorNum === 0) continue;

      const cell = getCell(ws, `C${r}`);
      const esPse = is99CCFF(cell);
      const es4x = es4x1000Line(concepto);
      const refs = extraerReferencias(concepto);
      const provNombre = inferirProveedor(concepto, refs);

      terceros.push({
        concepto,
        valor: toCOP(Math.abs(valorNum)),
        esPse,
        es4x1000: es4x,
        proveedorNombre: provNombre,
        referencias: refs,
        fila: r,
      });
    }
  }

  // ── Total terceros ────────────────────────────────────────────────────────
  let totalTerceros: bigint;
  if (filaTotalTerceros !== null) {
    const v = cellNumber(ws, `I${filaTotalTerceros}`);
    totalTerceros = toCOP(v);
  } else {
    totalTerceros = terceros.reduce((s, t) => s + t.valor, 0n);
  }

  // ── Operacionales ─────────────────────────────────────────────────────────
  const operacionales: LineaOperacional[] = [];
  if (inicioOperacionales !== null) {
    // Scan from inicioOperacionales until we hit IVA row or retenciones
    const ivaStop = filaIva ?? maxRow;
    for (let r = inicioOperacionales; r < ivaStop; r++) {
      const concepto = cellText(ws, `C${r}`);
      if (!concepto) continue;
      const cu = concepto.toUpperCase();
      // Skip IVA lines (% IVA pattern), MENOS lines, and retenciones lines
      if (/%\s*IVA/.test(cu) || cu.includes("MENOS") || esRetencionLine(concepto)) break;
      const valorNum = cellNumber(ws, `I${r}`);
      if (valorNum === null || valorNum === 0) continue;

      operacionales.push({
        concepto,
        valor: toCOP(Math.abs(valorNum)),
        fila: r,
      });
    }
  }

  const totalOperacionales = operacionales.reduce((s, o) => s + o.valor, 0n);

  // ── IVA ───────────────────────────────────────────────────────────────────
  let iva = 0n;
  if (filaIva !== null) {
    const v = cellNumber(ws, `I${filaIva}`);
    iva = toCOP(v);
  }

  // ── Retenciones ───────────────────────────────────────────────────────────
  // Deduplicate rows
  const retFilasUnicas = [...new Set(filaRetenciones)].sort((a, b) => a - b);
  const retenciones: LineaRetencion[] = [];
  for (const r of retFilasUnicas) {
    // Concepto can be in D (when C has "MENOS.") or in C
    const concepto = cellText(ws, `D${r}`) ?? cellText(ws, `C${r}`) ?? "RETENCIÓN";
    const valorNum = cellNumber(ws, `I${r}`);
    if (valorNum === null || valorNum === 0) continue;

    retenciones.push({
      concepto,
      valor: toCOP(Math.abs(valorNum)),
      fila: r,
    });
  }

  const totalRetenciones = retenciones.reduce((s, r) => s + r.valor, 0n);

  // ── Totales: TOTAL FACTURA, ANTICIPO, SALDO ───────────────────────────────
  let totalFactura = 0n;
  let anticipo = 0n;
  let saldoAFavor = 0n;

  if (filaTotalFactura !== null) {
    const tfVal = cellNumber(ws, `I${filaTotalFactura}`);
    totalFactura = toCOP(tfVal);

    const antiVal = cellNumber(ws, `I${filaTotalFactura + 1}`);
    anticipo = toCOP(antiVal);

    // Saldo: en el Excel es negativo cuando es a favor
    // La celda puede tener formato "(X.XXX.XXX)" que xlsx parsea como negativo
    const saldoVal = cellNumber(ws, `I${filaTotalFactura + 2}`);
    if (saldoVal !== null) {
      // Negative = a favor del cliente → store as positive
      saldoAFavor = toCOP(Math.abs(saldoVal));
    }
  }

  return {
    filePath,
    sheetName,
    clienteNombre,
    clienteNit,
    numFactura,
    fecha,
    do: doInfo,
    terceros,
    totalTerceros,
    operacionales,
    totalOperacionales,
    iva,
    retenciones,
    totalRetenciones,
    totalFactura,
    anticipo,
    saldoAFavor,
  };
}

// ─── Reconciliación ───────────────────────────────────────────────────────────

/**
 * Verifica las invariantes del borrador:
 * 1. terceros + operacionales + IVA − retenciones = totalFactura
 * 2. anticipo − totalFactura = saldoAFavor
 *
 * Retorna un arreglo de discrepancias (vacío = cuadra al peso).
 */
export function reconciliar(p: BorradorLuchoParseado): ResultadoReconciliacion {
  const discrepancias: Discrepancia[] = [];

  const calculadoTotal =
    p.totalTerceros + p.totalOperacionales + p.iva - p.totalRetenciones;
  if (calculadoTotal !== p.totalFactura) {
    discrepancias.push({
      campo: "totalFactura",
      esperado: p.totalFactura,
      calculado: calculadoTotal,
      diferencia: p.totalFactura - calculadoTotal,
    });
  }

  const calculadoSaldo = p.anticipo - p.totalFactura;
  if (calculadoSaldo !== p.saldoAFavor) {
    discrepancias.push({
      campo: "saldoAFavor",
      esperado: p.saldoAFavor,
      calculado: calculadoSaldo,
      diferencia: p.saldoAFavor - calculadoSaldo,
    });
  }

  return discrepancias;
}
