/**
 * Exportación a Excel del estado de cuenta con el proveedor (CxP v2, diseño
 * §D.1 "Exportar"). Se genera EN EL NAVEGADOR (`import("xlsx")` al hacer
 * clic, sin ruta de servidor) porque el paquete P3 no es dueño de `api/**`.
 *
 * Hoja CARTERA: mismas columnas del Excel de Camila (FACTURA · PROVEEDOR ·
 * DO · FECHA · TOTAL · PAGO) + columnas extra (SALDO, ESTADO, ABONOS,
 * CLIENTE, DO SISTEMA, COMPROBANTE). La columna PAGO queda VACÍA mientras la
 * factura tenga saldo (el Excel de Camila calcula "C X P" con
 * `SUMIFS(E,F,"")`: si se pusiera la fecha de un abono, la deuda
 * desaparecería del cálculo) — la fecha y el monto de los abonos van aparte,
 * en ABONOS.
 * Hoja PAGOS: el registro de "Pagos realizados" tal como se ve en la ficha.
 *
 * Las funciones que arman las filas (`filasHojaCartera`, `filasHojaPagos`)
 * son PURAS (sin `xlsx`, sin DOM): se prueban en `cxp-export.test.ts`. Solo
 * `exportarEstadoCuentaProveedor` toca el navegador.
 */

import type { FilaEstadoCuentaJson, PagoRealizadoJson, ResumenCxpJson } from "@/lib/cxp/contratos-api";
import { formatCOP } from "@/components/pagos/pagos-global-api";
import { aFechaCalendario, formatFechaCalendario, formatInstanteBogota, hoyBogotaISO } from "@/lib/tiempo/bogota";

type Celda = string | number | Date;

/** COP entero serializado → número (seguro: COP < 2^53). "" en blanco → 0. */
function numeroCOP(v: string): number {
  try {
    return Number(BigInt(v || "0"));
  } catch {
    return 0;
  }
}

const CANAL_LABEL: Record<string, string> = {
  TRANSF_BANCOLOMBIA: "Transf. Bancolombia",
  PSE: "PSE",
  TRANSF_OTROS_BANCOS: "Transf. Otros Bancos",
};

const COSTO_ASUMIDO_LABEL: Record<string, string> = {
  GALCOMEX: "Galcomex",
  PRIMER_DO: "primer DO cobrable",
  PRORRATEADO: "repartido entre DOs",
};

/**
 * Fecha-calendario como celda de Excel. SheetJS convierte un `Date` con la
 * hora LOCAL del navegador: una fecha a 00:00 UTC en Bogotá quedaba en el día
 * anterior a las 19:00. Se arma el mismo día a medianoche LOCAL, así la celda
 * es un día exacto (serial entero) en cualquier zona horaria; el formato
 * dd/mm/yyyy lo pone `exportarEstadoCuentaProveedor` (`dateNF`).
 */
export function fechaParaExcel(v: string | Date): Date {
  const d = aFechaCalendario(v);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Formato de las celdas de fecha del Excel exportado (como el Excel de Camila). */
export const FORMATO_FECHA_EXCEL = "dd/mm/yyyy";

/** "16/09/2026: $100.000; 20/09/2026: $161.377" — columna ABONOS. */
function textoAbonos(abonos: FilaEstadoCuentaJson["abonos"]): string {
  return abonos
    .map((a) => `${a.fecha ? formatFechaCalendario(a.fecha) : "—"}: ${formatCOP(a.monto)}`)
    .join("; ");
}

export const ENCABEZADOS_CARTERA = [
  "FACTURA",
  "PROVEEDOR",
  "DO",
  "FECHA",
  "TOTAL",
  "PAGO",
  "SALDO",
  "ESTADO",
  "ABONOS",
  "CLIENTE",
  "DO SISTEMA",
  "COMPROBANTE",
] as const;

/** Fila 1 de la hoja CARTERA: "CARTERA | {proveedor} | | | | C X P | {saldo}". */
export function filaTituloCartera(nombreProveedor: string, cxp: string): Celda[] {
  return ["CARTERA", nombreProveedor, "", "", "", "C X P", numeroCOP(cxp)];
}

/** Una fila de factura para la hoja CARTERA, en el orden de `ENCABEZADOS_CARTERA`. */
export function filaCartera(f: FilaEstadoCuentaJson): Celda[] {
  return [
    f.numFacturaVisible,
    f.marca ?? "",
    f.doCorto,
    fechaParaExcel(f.fecha),
    numeroCOP(f.valor),
    // PAGO: solo si la factura quedó en saldo 0 (vacío = "aún se debe", igual
    // que el Excel de Camila).
    f.fechaPago ? formatFechaCalendario(f.fechaPago) : "",
    numeroCOP(f.saldo),
    f.etiqueta,
    textoAbonos(f.abonos),
    f.clienteNombre,
    f.tramiteConsecutivo,
    f.pagos.some((p) => p.comprobante !== null) ? "Sí" : "No",
  ];
}

/** Filas completas de la hoja CARTERA (título, línea en blanco, encabezados, datos). */
export function filasHojaCartera(
  nombreProveedor: string,
  resumen: Pick<ResumenCxpJson, "pendiente">,
  facturas: FilaEstadoCuentaJson[],
): Celda[][] {
  return [
    filaTituloCartera(nombreProveedor, resumen.pendiente),
    [],
    [...ENCABEZADOS_CARTERA],
    ...facturas.map(filaCartera),
  ];
}

export const ENCABEZADOS_PAGOS = [
  "FECHA",
  "CONCEPTO",
  "VALOR",
  "CANAL",
  "COSTO TRANSFERENCIA",
  "LO ASUME",
  "DOs",
  "FACTURAS",
  "COMPROBANTE",
  "ESTADO",
] as const;

function textoEstadoPago(p: PagoRealizadoJson): string {
  if (p.estado === "ANULADO" && p.anulacion) {
    return `Anulado el ${formatInstanteBogota(p.anulacion.en)}${p.anulacion.por ? ` por ${p.anulacion.por}` : ""}: ${p.anulacion.motivo}`;
  }
  if (p.esHistorico) return "Registro histórico (Excel)";
  return "Activo";
}

/** Una fila de "Pagos realizados" para la hoja PAGOS. */
export function filaPago(p: PagoRealizadoJson): Celda[] {
  return [
    p.fecha ? formatFechaCalendario(p.fecha) : "",
    p.concepto,
    numeroCOP(p.valor),
    CANAL_LABEL[p.canalPago] ?? p.canalPago,
    numeroCOP(p.costoBancario),
    p.costoAsumidoPor ? (COSTO_ASUMIDO_LABEL[p.costoAsumidoPor] ?? p.costoAsumidoPor) : "",
    p.dos.map((d) => d.consecutivo).join(", "),
    p.facturas.map((f) => f.numFactura).join(", "),
    p.comprobante ? "Sí" : "No",
    textoEstadoPago(p),
  ];
}

/** Filas completas de la hoja PAGOS (encabezados + datos). */
export function filasHojaPagos(pagos: PagoRealizadoJson[]): Celda[][] {
  return [[...ENCABEZADOS_PAGOS], ...pagos.map(filaPago)];
}

/** Nombre de archivo sin caracteres raros: "cartera-almacarga-2026-09-24.xlsx". */
function nombreArchivo(nombreProveedor: string): string {
  const slug = nombreProveedor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `cartera-${slug || "proveedor"}-${hoyBogotaISO()}.xlsx`;
}

/**
 * Genera y descarga el Excel del estado de cuenta con el proveedor (dos
 * hojas: CARTERA y PAGOS). Solo se llama desde el navegador (importa `xlsx`
 * dinámicamente para no engordar el bundle inicial de la ficha).
 */
export async function exportarEstadoCuentaProveedor(input: {
  nombreProveedor: string;
  resumen: Pick<ResumenCxpJson, "pendiente">;
  facturas: FilaEstadoCuentaJson[];
  pagos: PagoRealizadoJson[];
}): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(filasHojaCartera(input.nombreProveedor, input.resumen, input.facturas), {
      dateNF: FORMATO_FECHA_EXCEL,
    }),
    "CARTERA",
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filasHojaPagos(input.pagos)), "PAGOS");
  XLSX.writeFile(wb, nombreArchivo(input.nombreProveedor));
}
