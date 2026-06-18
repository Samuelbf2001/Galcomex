/**
 * siigo-import.ts — Genera el archivo de importación de FACTURAS DE VENTA de SIIGO Nube.
 *
 * Formato oficial (plantilla "Subir desde Excel – Facturas de venta", columnas A–AE):
 * https://siigonube.portaldeclientes.siigo.com/subir-desde-excel-facturas-de-venta/
 *
 * Reglas SIIGO:
 *  - NO se deben modificar, eliminar ni adicionar columnas (se emiten las 31, A–AE).
 *  - Máximo 500 registros por archivo.
 *  - Una fila por LÍNEA de la factura; varias filas comparten el mismo consecutivo = 1 factura.
 *
 * Decisión de modelado (puente de transcripción, total exacto):
 *  - Cada concepto/pago + comisión + IVA + 4x1000 + costos se emite como LÍNEA con su valor,
 *    de modo que la suma cuadre al peso con totalFactura. La columna W (código IVA) se deja
 *    para que el contador la active sobre la comisión si se requiere tratamiento de impuesto.
 *  - Dinero: BigInt (COP entero) → number en la celda numérica.
 */

import * as XLSX from "xlsx";

// ─── Configuración (códigos propios de la cuenta SIIGO de Galcomex) ─────────────
export interface SiigoImportConfig {
  tipoComprobante: string; // Col A — código del tipo FV (ej. "1")
  codProducto: string; // Col N — código del producto/servicio en SIIGO
  idVendedor: string; // Col P — cédula del vendedor (opcional)
  codIva: string; // Col W — código de impuesto IVA (se aplica a la comisión)
  codFormaPago: string; // Col AB — código de forma de pago
  consecutivo?: string; // Col B — si SIIGO no lo autoasigna en el cargue
}

// ─── DTO de entrada (lo que se lee del borrador) ────────────────────────────────
export interface SiigoLineaDto {
  concepto: string;
  valor: bigint;
  esComision?: boolean; // marca la línea de comisión (lleva código IVA en col W)
}

export interface SiigoFacturaImportDto {
  identificacionTercero: string; // NIT del cliente (col C)
  fecha: Date; // col F
  observaciones?: string | null; // col AE (ej. "DO.BUN26-0026")
  lineas: SiigoLineaDto[];
  totalFormaPago: bigint; // col AC — valor de la forma de pago (total factura)
}

// ─── Columnas oficiales de la plantilla (orden exacto A–AE) ─────────────────────
const COLUMNAS: string[] = [
  "Tipo de comprobante", // A
  "Consecutivo", // B
  "Identificacion tercero", // C
  "Sucursal", // D
  "Centro/subcentro de costos", // E
  "Fecha de elaboracion", // F
  "Sigla Moneda", // G
  "Tasa de cambio", // H
  "Nombre contacto", // I
  "Email Contacto", // J
  "Orden de compra", // K
  "Orden de entrega", // L
  "Fecha orden de entrega", // M
  "Codigo producto", // N
  "Descripcion producto", // O
  "Identificacion vendedor", // P
  "Codigo de Bodega", // Q
  "Cantidad producto", // R
  "Valor unitario", // S
  "Valor Descuento", // T
  "Base AIU", // U
  "Identificacion ingreso para terceros", // V
  "Codigo impuesto cargo", // W
  "Codigo impuesto cargo dos", // X
  "Codigo impuesto retencion", // Y
  "Codigo ReteICA", // Z
  "Codigo ReteIVA", // AA
  "Codigo forma de pago", // AB
  "Valor forma de pago", // AC
  "Fecha Vencimiento", // AD
  "Observaciones", // AE
];

const COL_COUNT = COLUMNAS.length; // 31

function fechaSiigo(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Solo dígitos del NIT (SIIGO espera el número de identificación sin guiones/DV). */
function soloDigitos(nit: string): string {
  const limpio = nit.replace(/\D/g, "");
  // Si viene con dígito de verificación tipo "900123456-7", quita el DV final.
  if (/-\d$/.test(nit)) {
    return limpio.slice(0, -1);
  }
  return limpio;
}

type Celda = string | number | null;

/**
 * Construye la matriz de filas (incluye encabezado) en el orden exacto A–AE.
 * Una fila por línea de la factura.
 */
export function construirFilasSiigoImport(
  dto: SiigoFacturaImportDto,
  config: SiigoImportConfig,
): Celda[][] {
  const filas: Celda[][] = [COLUMNAS.slice()];
  const fechaStr = fechaSiigo(dto.fecha);
  const tercero = soloDigitos(dto.identificacionTercero);

  dto.lineas.forEach((linea, idx) => {
    const fila: Celda[] = new Array<Celda>(COL_COUNT).fill(null);
    fila[0] = config.tipoComprobante; // A
    fila[1] = config.consecutivo ?? null; // B
    fila[2] = tercero; // C
    fila[5] = fechaStr; // F
    fila[6] = "COP"; // G
    fila[13] = config.codProducto; // N
    fila[14] = linea.concepto.slice(0, 250); // O
    fila[15] = config.idVendedor || null; // P
    fila[17] = 1; // R cantidad
    fila[18] = Number(linea.valor); // S valor unitario (COP entero)
    if (linea.esComision && config.codIva) {
      fila[22] = config.codIva; // W código IVA sobre la comisión
    }
    // Forma de pago: una sola vez, en la primera línea, con el total
    if (idx === 0) {
      fila[27] = config.codFormaPago || null; // AB
      fila[28] = Number(dto.totalFormaPago); // AC
    }
    fila[30] = dto.observaciones ?? null; // AE
    filas.push(fila);
  });

  return filas;
}

export const SIIGO_IMPORT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Genera el buffer XLSX con la hoja en formato de importación SIIGO. */
export function construirFacturaSiigoImportXlsx(
  dto: SiigoFacturaImportDto,
  config: SiigoImportConfig,
): Buffer {
  const filas = construirFilasSiigoImport(dto, config);
  const ws = XLSX.utils.aoa_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Facturas");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function nombreArchivoSiigoImport(numFactura: string | null, id: string): string {
  const ref = (numFactura ?? id).replace(/[^A-Za-z0-9_-]/g, "_");
  return `siigo-import-${ref}.xlsx`;
}
