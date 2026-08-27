/**
 * Motor de importación del workbook histórico "GRUPO E PAPIS 2026.xlsm".
 *
 * Generaliza `scripts/replicar-grupo-e-papis.ts` a las 26 hojas DO del libro.
 * Por cada hoja DO (layout PROPIO idéntico al test dorado BUN26-0026):
 *   - Deriva consecutivo / ciudad / año / número del nombre de hoja.
 *   - dryRun=true  → calcula los valores "sistema" con el motor PURO
 *     (`calcularBorrador`) replicando exactamente las entradas que armaría
 *     `generarBorrador`, SIN tocar la BD. Sirve de preview y de test sin BD.
 *   - dryRun=false → persiste vía los servicios reales (DO + anticipo(s) +
 *     aplicación + pagos + borrador) y avanza el borrador a FACTURADO.
 *   - Reconcilia los conceptos clave contra las celdas del Excel a 0 pesos.
 *
 * INVARIANTE: todo el dinero es BigInt (COP enteros). El resultado se devuelve
 * por JSON, por lo que los montos de la reconciliación se serializan a string.
 */

import {
  AgenciaAduanas,
  CanalPago,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  TipoRecaudo,
} from "@prisma/client";
import * as XLSX from "xlsx";

import { calcularBorrador } from "@/lib/calculations/motor-factura";
import { prisma } from "@/lib/db/prisma";
import {
  listDoSheets,
  parseDoSheetFromWorkbook,
  type ParsedDoSheet,
} from "@/lib/excel/galcomex-workbook";
import { getParametrosSistema } from "@/lib/parametros/service";

import { generarBorrador, transicionarBorrador } from "@/lib/borradores/service";
import { crearPago } from "@/lib/pagos/service";
import { transitionTramite } from "@/lib/tramites/service";

// ─── Contrato público (los agentes de API/UI programan contra esto) ────────────

export interface FilaReconciliacion {
  concepto: string;
  /** Valor calculado/persistido por el sistema (BigInt serializado). */
  sistema: string;
  /** Valor leído del Excel (BigInt serializado). */
  excel: string;
  ok: boolean;
}

export interface ResultadoHoja {
  sheetName: string;
  consecutivo: string;
  numFacturaSiigo: string | null;
  estado: "IMPORTADO" | "OMITIDO" | "YA_EXISTIA" | "ERROR";
  motivo?: string;
  /** El registro persistido coincide con el Excel (true para todo IMPORTADO). */
  cuadra: boolean;
  /**
   * El Excel tiene valores derivados (total factura / 4x1000 / saldos) digitados
   * a mano que el motor PROPIO no reproduce (típico en DOs con saldo a cargo). Se
   * persiste el valor del Excel (fuente de verdad histórica) y se marca aquí.
   * `reconciliacion` muestra el detalle motor-vs-Excel de lo ajustado.
   */
  requirioOverride: boolean;
  /** Comparación motor (sistema) vs Excel — transparencia de lo importado. */
  reconciliacion: FilaReconciliacion[];
}

export interface ResultadoImport {
  clienteId: string;
  totalHojas: number;
  importadas: number;
  omitidas: number;
  errores: number;
  hojas: ResultadoHoja[];
}

export interface ImportarWorkbookInput {
  workbook: XLSX.WorkBook;
  clienteId: string;
  usuarioId: string;
  dryRun: boolean;
}

// ─── Mapeos Excel → enums (extraídos de scripts/replicar-grupo-e-papis.ts) ──────

/** Mapea el canal de pago del Excel al enum CanalPago. */
export function mapCanalPago(excel: string | null): CanalPago {
  const v = (excel ?? "").toUpperCase().trim();
  if (v === "TRANSF BANCOLOMBIA") return CanalPago.TRANSF_BANCOLOMBIA;
  if (v === "TRANSF OTROS BANCOS") return CanalPago.TRANSF_OTROS_BANCOS;
  if (v === "PSE") return CanalPago.PSE;
  return CanalPago.TRANSF_BANCOLOMBIA;
}

/** Mapea el canal de RECAUDO del anticipo del Excel al enum TipoRecaudo. */
export function mapTipoRecaudo(excel: string | null): TipoRecaudo {
  const v = (excel ?? "").toUpperCase().trim();
  if (v === "BANCOLOMBIA") return TipoRecaudo.BANCOLOMBIA;
  if (v === "OTROS BANCOS") return TipoRecaudo.OTROS_BANCOS;
  if (v === "SUCURSAL") return TipoRecaudo.SUCURSAL;
  if (v === "CORRESPONSAL") return TipoRecaudo.CORRESPONSAL;
  if (v === "CAJERO") return TipoRecaudo.CAJERO;
  return TipoRecaudo.BANCOLOMBIA;
}

/**
 * Matriz de costos de recaudo (anticipo). Réplica de `prisma/seed.ts` para el
 * camino dryRun (sin BD). El camino real lo resuelve `crearAnticipo` desde
 * `MatrizRecaudo`; ambos producen el mismo valor.
 */
const COSTO_RECAUDO: Record<TipoRecaudo, bigint> = {
  [TipoRecaudo.BANCOLOMBIA]: 1_950n,
  [TipoRecaudo.OTROS_BANCOS]: 2_200n,
  [TipoRecaudo.SUCURSAL]: 11_290n,
  [TipoRecaudo.CORRESPONSAL]: 6_190n,
  [TipoRecaudo.CAJERO]: 5_200n,
};

/**
 * Matriz de costos bancarios de pago. Réplica de `prisma/seed.ts` para dryRun.
 * El camino real lo resuelve `crearPago` desde `MatrizPago`.
 */
const COSTO_PAGO: Record<CanalPago, bigint> = {
  [CanalPago.TRANSF_BANCOLOMBIA]: 3_900n,
  [CanalPago.PSE]: 0n,
  [CanalPago.TRANSF_OTROS_BANCOS]: 7_300n,
};

// ─── Helpers de parseo de celdas ────────────────────────────────────────────────

const SHEET_NAME_PATTERN = /^([A-Z]{3})(\d{2})-(\d{4})$/;

/** Convierte un número del Excel a BigInt (COP enteros, redondeo al entero más cercano). */
function toBigInt(value: number | null | undefined): bigint {
  return BigInt(Math.round(Number(value ?? 0)));
}

interface DatosHoja {
  consecutivo: string;
  ciudad: Ciudad;
  anio: number;
  numero: number;
  numFacturaSiigo: string | null;
  fechaFactura: Date;
  anticipoTotal: bigint;
  costoRecaudoTotal: bigint;
  anticipoRows: Array<{
    monto: bigint;
    fecha: Date | null;
    tipoRecaudo: TipoRecaudo;
    costoRecaudo: bigint;
  }>;
  pagos: Array<{
    concepto: string;
    numSoporte: string | null;
    valor: bigint;
    canalPago: CanalPago;
    costoBancario: bigint;
  }>;
  comision: bigint;
  ivaComision: bigint;
  montoLM: bigint;
  // Valores de referencia del Excel (para reconciliar)
  totalPagosExcel: bigint;
  costosBancariosExcel: bigint;
  impuesto4x1000Excel: bigint;
  totalFacturaExcel: bigint;
  saldoClienteExcel: bigint;
  saldoLMExcel: bigint;
}

function mapCiudad(prefijo: string): Ciudad | null {
  if (prefijo === "BAQ") return Ciudad.BAQ;
  if (prefijo === "CTG") return Ciudad.CTG;
  if (prefijo === "BUN") return Ciudad.BUN;
  if (prefijo === "SMR") return Ciudad.SMR;
  return null;
}

/** Una hoja se omite si no está facturada (factura BAQ-XXXXX o total vacío). */
function esNoFacturable(parsed: ParsedDoSheet): boolean {
  const factura = parsed.metadata.invoiceNumber ?? "";
  if (/X{3,}/i.test(factura)) return true;
  if (parsed.totals.invoiceTotal === null) return true;
  return false;
}

/**
 * Extrae y normaliza todos los datos de una hoja DO a tipos del dominio.
 * Lanza si el nombre de hoja o la ciudad no son válidos.
 */
function extraerDatosHoja(parsed: ParsedDoSheet): DatosHoja {
  const match = SHEET_NAME_PATTERN.exec(parsed.sheetName);
  if (!match) {
    throw new Error(`Nombre de hoja inválido: ${parsed.sheetName}`);
  }
  const [, prefijo, aa, nnnn] = match;
  const ciudad = mapCiudad(prefijo);
  if (!ciudad) {
    throw new Error(`Ciudad no soportada en hoja ${parsed.sheetName}: ${prefijo}`);
  }
  const anio = 2000 + Number(aa);
  const numero = Number(nnnn);
  const consecutivo = `DO.${parsed.sheetName}`;

  // ── Anticipos: una fila por cada renglón con monto; suma de todos ──
  const anticipoRows = parsed.advance.rows
    .filter((r) => toBigInt(r.amount) !== 0n)
    .map((r) => {
      const tipoRecaudo = mapTipoRecaudo(r.collectionType);
      return {
        monto: toBigInt(r.amount),
        fecha: r.date ? new Date(r.date) : null,
        tipoRecaudo,
        // Solo las filas con tipo de recaudo explícito generan costo (réplica
        // de la fórmula Excel D18 = SUM(D5:D17), donde solo el depósito real
        // bancario lleva costo).
        costoRecaudo: r.collectionType ? COSTO_RECAUDO[tipoRecaudo] : 0n,
      };
    });
  const anticipoTotal = anticipoRows.reduce((s, r) => s + r.monto, 0n);
  const costoRecaudoTotal = anticipoRows.reduce((s, r) => s + r.costoRecaudo, 0n);

  // ── Pagos ──
  const pagos = parsed.payments.rows.map((r) => {
    const canalPago = mapCanalPago(r.paymentType);
    return {
      concepto: String(r.concept ?? "Pago"),
      numSoporte: r.invoiceReference ? String(r.invoiceReference) : null,
      valor: toBigInt(r.amount),
      canalPago,
      costoBancario: COSTO_PAGO[canalPago],
    };
  });

  // ── Costos de la hoja (filas A38:A41) ──
  const costoPorConcepto = new Map(
    parsed.costs.rows.map((c) => [
      String(c.concept ?? "").toUpperCase(),
      toBigInt(c.amount),
    ]),
  );
  const comision = costoPorConcepto.get("COMISIÓN GALCOMEX") ?? 0n;
  const ivaComision = costoPorConcepto.get("IVA COMISIÓN") ?? 0n;
  const impuesto4x1000Excel = costoPorConcepto.get("IMPUESTO 4X1000") ?? 0n;
  const costosBancariosExcel = costoPorConcepto.get("COSTOS BANCARIOS") ?? 0n;

  // ── Saldo LM (B51): puede venir vacío en DOs con saldo a cargo → 0n ──
  const montoLM = toBigInt(parsed.totals.luisMartinezBalance);

  const fechaFactura = fechaFacturaDeHoja(parsed);

  return {
    consecutivo,
    ciudad,
    anio,
    numero,
    numFacturaSiigo: parsed.metadata.invoiceNumber ?? null,
    fechaFactura,
    anticipoTotal,
    costoRecaudoTotal,
    anticipoRows,
    pagos,
    comision,
    ivaComision,
    montoLM,
    totalPagosExcel: toBigInt(parsed.payments.amountTotal),
    costosBancariosExcel,
    impuesto4x1000Excel,
    totalFacturaExcel: toBigInt(parsed.totals.invoiceTotal),
    saldoClienteExcel: toBigInt(parsed.totals.clientBalance),
    saldoLMExcel: montoLM,
  };
}

/** Fecha de factura: celda B45 del resumen (FECHA). Default = fecha de hoy. */
function fechaFacturaDeHoja(parsed: ParsedDoSheet): Date {
  const iso = parsed.summary.invoiceDate?.dateIso;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

// ─── Reconciliación ─────────────────────────────────────────────────────────────

interface ValoresSistema {
  totalAnticipo: bigint;
  totalPagos: bigint;
  costosBancarios: bigint;
  comision: bigint;
  ivaComision: bigint;
  impuesto4x1000: bigint;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
}

/**
 * Compara los valores NATIVOS del motor (`sistema`) contra el Excel. Las filas con
 * `ok=false` son las que el motor no reproduce y que se persisten con el valor del
 * Excel (fuente de verdad histórica). `requirioOverride` resume si hubo alguna.
 */
function construirReconciliacion(
  sistema: ValoresSistema,
  datos: DatosHoja,
): { reconciliacion: FilaReconciliacion[]; requirioOverride: boolean } {
  // El saldo del cliente puede ser a favor (positivo) o a cargo (negativo).
  const saldoClienteSistema =
    sistema.saldoAFavorCliente - sistema.saldoACargoCliente;

  const filas: Array<[string, bigint, bigint]> = [
    ["Anticipo aplicado", sistema.totalAnticipo, datos.anticipoTotal],
    ["Total pagos", sistema.totalPagos, datos.totalPagosExcel],
    ["Costos bancarios", sistema.costosBancarios, datos.costosBancariosExcel],
    ["Comisión", sistema.comision, datos.comision],
    ["IVA comisión", sistema.ivaComision, datos.ivaComision],
    ["Impuesto 4x1000", sistema.impuesto4x1000, datos.impuesto4x1000Excel],
    ["TOTAL FACTURA", sistema.totalFactura, datos.totalFacturaExcel],
    ["Saldo a favor cliente", saldoClienteSistema, datos.saldoClienteExcel],
    ["Saldo a favor LM", sistema.saldoAFavorLM, datos.saldoLMExcel],
  ];

  let requirioOverride = false;
  const reconciliacion: FilaReconciliacion[] = filas.map(([concepto, sis, exc]) => {
    const ok = sis === exc;
    if (!ok) requirioOverride = true;
    return {
      concepto,
      sistema: sis.toString(),
      excel: exc.toString(),
      ok,
    };
  });

  return { reconciliacion, requirioOverride };
}

// ─── Cálculo motor puro (sin BD) — usado para reconciliar en AMBOS caminos ────────

/**
 * Calcula los valores NATIVOS del motor PROPIO (sin BD). Se usa para la
 * reconciliación tanto en dryRun como en el camino real, de modo que el flag
 * `requirioOverride` sea idéntico en la previsualización y en la importación.
 */
async function calcularSistemaMotor(datos: DatosHoja): Promise<ValoresSistema> {
  // Parámetros del sistema: en dryRun se intentan leer de BD; si no hay BD,
  // se usan los defaults del Excel (tasaIva=19, tasa4x1000=400). Esto mantiene
  // el path de test 100% sin BD.
  let tasaIva = 19n;
  let tasa4x1000 = 400n;
  try {
    const params = await getParametrosSistema();
    tasaIva = params.tasaIva;
    tasa4x1000 = params.tasa4x1000;
  } catch {
    // Sin BD: defaults del Excel.
  }

  const resultado = calcularBorrador({
    totalAnticipoAplicado: datos.anticipoTotal,
    costoRecaudoAnticipo: datos.costoRecaudoTotal,
    pagos: datos.pagos.map((p) => ({ valor: p.valor, costoBancario: p.costoBancario })),
    comision: datos.comision,
    ivaComision: datos.ivaComision,
    tasaIva,
    tasa4x1000,
    montoLM: datos.montoLM,
  });

  return {
    totalAnticipo: datos.anticipoTotal,
    totalPagos: resultado.totalPagos,
    costosBancarios: resultado.costosBancarios,
    comision: resultado.comision,
    ivaComision: resultado.ivaComision,
    impuesto4x1000: resultado.impuesto4x1000,
    totalFactura: resultado.totalFactura,
    saldoAFavorCliente: resultado.saldoAFavorCliente,
    saldoACargoCliente: resultado.saldoACargoCliente,
    saldoAFavorLM: resultado.saldoAFavorLM,
  };
}

// ─── Persistencia (camino real, dryRun=false) ────────────────────────────────────

async function persistirHoja(
  datos: DatosHoja,
  clienteId: string,
  usuarioId: string,
): Promise<void> {
  // 1. TramiteDO en estado ENVIADO_A_FACTURAR (requisito de generarBorrador).
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: datos.consecutivo,
      ciudad: datos.ciudad,
      anio: datos.anio,
      numero: datos.numero,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      doCliente: datos.numFacturaSiigo,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      creadoPorId: usuarioId,
      comentarios: `IMPORT:${datos.consecutivo}`,
    },
  });

  // 2. Anticipo(s) por hoja + aplicación. Se modela un Anticipo por fila del
  //    Excel con su costoRecaudo snapshot, y se aplica el total al DO.
  for (const row of datos.anticipoRows) {
    const anticipo = await prisma.anticipo.create({
      data: {
        clienteId,
        monto: row.monto,
        fecha: row.fecha ?? datos.fechaFactura,
        tipoRecaudo: row.tipoRecaudo,
        costoRecaudo: row.costoRecaudo,
        soporteKey: `IMPORT:${datos.consecutivo}`,
        verificadoBanco: true,
      },
    });
    await prisma.aplicacionAnticipo.create({
      data: {
        anticipoId: anticipo.id,
        tramiteId: tramite.id,
        montoAplicado: row.monto,
      },
    });
  }

  // 3. Pagos (crearPago resuelve costoBancario desde MatrizPago).
  for (const p of datos.pagos) {
    await crearPago({
      tramiteId: tramite.id,
      concepto: p.concepto,
      numSoporte: p.numSoporte,
      valor: p.valor,
      canalPago: p.canalPago,
      usuarioId,
    });
  }

  // 4. Borrador con comisión / IVA / montoLM de las celdas.
  const borrador = await generarBorrador({
    tramiteId: tramite.id,
    comision: datos.comision,
    ivaComision: datos.ivaComision,
    montoLM: datos.montoLM,
    usuarioId,
  });

  // 4b. OVERRIDE con los valores del Excel (fuente de verdad histórica).
  //     El motor PROPIO no reproduce el total factura / 4x1000 / saldos digitados
  //     a mano en el Excel (DOs con saldo a cargo). Persistimos el Excel — mismo
  //     criterio que `scripts/importar-borrador-lucho.ts`. Se hace ANTES de
  //     transicionar a FACTURADO para que la Factura emitida tome estos valores.
  const saldoCliente = datos.saldoClienteExcel;
  await prisma.borradorFactura.update({
    where: { id: borrador.id },
    data: {
      costosBancarios: datos.costosBancariosExcel,
      impuesto4x1000: datos.impuesto4x1000Excel,
      totalFactura: datos.totalFacturaExcel,
      saldoAFavorCliente: saldoCliente > 0n ? saldoCliente : 0n,
      saldoACargoCliente: saldoCliente < 0n ? -saldoCliente : 0n,
      saldoAFavorLM: datos.saldoLMExcel,
    },
  });

  // 5. Avanzar EN_REVISION → APROBADO → FACTURADO.
  const numFacturaSiigo = datos.numFacturaSiigo ?? datos.consecutivo;
  for (const estado of [
    EstadoBorrador.EN_REVISION,
    EstadoBorrador.APROBADO,
    EstadoBorrador.FACTURADO,
  ] as const) {
    const res = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: estado,
      usuarioId,
      ...(estado === EstadoBorrador.FACTURADO
        ? { numFacturaSiigo, fechaFactura: datos.fechaFactura }
        : {}),
    });
    if (!res.ok) {
      throw new Error(`No se pudo transicionar a ${estado}: ${res.message}`);
    }
  }

  // 6. Avanzar el TramiteDO ENVIADO_A_FACTURAR → FACTURADO (EstadoLog + AuditLog).
  const tramiteRes = await transitionTramite(
    tramite.id,
    EstadoTramite.FACTURADO,
    usuarioId,
  );
  if (!tramiteRes.ok) {
    throw new Error(
      `No se pudo marcar el DO como FACTURADO: ${tramiteRes.message}`,
    );
  }
}

// ─── Orquestador público ─────────────────────────────────────────────────────────

/**
 * Importa todas las hojas DO del workbook "GRUPO E PAPIS 2026", asociándolas al
 * `clienteId` dado y dejándolas en estado FACTURADO. Idempotente por consecutivo.
 *
 * - `dryRun: true`  → no escribe en BD; previsualiza y reconcilia con el motor puro.
 * - `dryRun: false` → persiste vía los servicios reales.
 *
 * Cada hoja se procesa de forma aislada (try/catch); un fallo no aborta el lote.
 */
export async function importarWorkbookGrupoEPapis(
  input: ImportarWorkbookInput,
): Promise<ResultadoImport> {
  const { workbook, clienteId, usuarioId, dryRun } = input;

  const sheetNames = listDoSheets(workbook);
  const hojas: ResultadoHoja[] = [];

  for (const sheetName of sheetNames) {
    const consecutivo = `DO.${sheetName}`;
    try {
      const parsed = parseDoSheetFromWorkbook(workbook, sheetName);

      // Omitir hojas no facturables (BAQ-XXXXX o total factura vacío).
      if (esNoFacturable(parsed)) {
        hojas.push({
          sheetName,
          consecutivo,
          numFacturaSiigo: parsed.metadata.invoiceNumber ?? null,
          estado: "OMITIDO",
          motivo: "Hoja no facturada (factura placeholder o total factura vacío)",
          cuadra: false,
          requirioOverride: false,
          reconciliacion: [],
        });
        continue;
      }

      const datos = extraerDatosHoja(parsed);

      // Idempotencia: si el DO ya existe, no duplicar (solo en modo real;
      // en dryRun no hay garantía de BD, así que se intenta y se ignora el fallo).
      if (!dryRun) {
        const existente = await prisma.tramiteDO.findUnique({
          where: { consecutivo },
          select: { id: true },
        });
        if (existente) {
          hojas.push({
            sheetName,
            consecutivo,
            numFacturaSiigo: datos.numFacturaSiigo,
            estado: "YA_EXISTIA",
            motivo: "El trámite ya existe; no se duplica",
            cuadra: false,
            requirioOverride: false,
            reconciliacion: [],
          });
          continue;
        }
      }

      // Reconciliación con el motor puro (idéntica en preview y real).
      const sistema = await calcularSistemaMotor(datos);

      // En el camino real se persiste el Excel (fuente de verdad) y se avanza el DO.
      if (!dryRun) {
        await persistirHoja(datos, clienteId, usuarioId);
      }

      const { reconciliacion, requirioOverride } = construirReconciliacion(
        sistema,
        datos,
      );

      // Se persiste el Excel (fuente de verdad), por eso el registro siempre
      // coincide con el Excel. `requirioOverride` indica si el motor difería.
      hojas.push({
        sheetName,
        consecutivo,
        numFacturaSiigo: datos.numFacturaSiigo,
        estado: "IMPORTADO",
        cuadra: true,
        requirioOverride,
        reconciliacion,
      });
    } catch (error) {
      hojas.push({
        sheetName,
        consecutivo,
        numFacturaSiigo: null,
        estado: "ERROR",
        motivo: error instanceof Error ? error.message : String(error),
        cuadra: false,
        requirioOverride: false,
        reconciliacion: [],
      });
    }
  }

  const importadas = hojas.filter(
    (h) => h.estado === "IMPORTADO" || h.estado === "YA_EXISTIA",
  ).length;
  const omitidas = hojas.filter((h) => h.estado === "OMITIDO").length;
  const errores = hojas.filter((h) => h.estado === "ERROR").length;

  return {
    clienteId,
    totalHojas: hojas.length,
    importadas,
    omitidas,
    errores,
    hojas,
  };
}
