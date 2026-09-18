/**
 * Arma los ítems de la factura de venta que se envía a Siigo desde las líneas
 * del borrador. Función pura (sin BD) para poder probarla contra facturas reales.
 *
 * Formato "COMISION" (Lucho, histórico): cada línea con valor es un ítem sin
 * `taxes`; el IVA viaja como su propia línea IVA_COMISION.
 *
 * Formato "CONCEPTOS_IVA" (Galcomex propio, verificado contra BAQ-18385): la
 * línea IVA_COMISION NO se envía; cada ingreso propio con `aplicaIva` lleva
 * `taxes: [{ id: <IVA 19 %> }]` y Siigo liquida el IVA por ítem. La ReteIVA va a
 * nivel de factura (`retentions`), fuera de este armador.
 *
 * Tercero de cada ítem: IMPUESTO_4X1000 → banco del GMF; TERCEROS sin tipoFija →
 * NIT manual, del beneficiario o del proveedor de la factura vinculada.
 */

import type { SiigoFacturaItemDto } from "./client";

export interface LineaParaSiigo {
  concepto: string;
  valor: bigint;
  orden: number;
  seccion: "TERCEROS" | "OPERACIONAL";
  tipoFija: string | null;
  aplicaIva: boolean;
  productoCodigo: string | null;
  /** NIT ya resuelto (manual → beneficiario → proveedor); null si no hay. */
  nitTercero: string | null;
  /**
   * Id del IVA que el propio producto Siigo tiene configurado, cuando su
   * porcentaje coincide con el que liquidó el motor (`ivaDelProducto`). Manda
   * sobre el IVA global: Siigo rechaza impuestos que no estén asociados al
   * producto. `null`/ausente → se usa `opciones.ivaTaxId` (comportamiento
   * histórico, casos dorados intactos).
   */
  ivaProductoId?: number | null;
}

export interface OpcionesItemsSiigo {
  formato: string;
  /** Id Siigo del IVA para los ítems gravados (solo CONCEPTOS_IVA). */
  ivaTaxId: number | null;
  nit4x1000: string;
}

/** Identificación como la espera Siigo: solo dígitos, sin dígito de verificación ("800.154.017-8" → "800154017"). */
export function identificacionSiigo(nit: string): string {
  return nit.split("-")[0]!.replace(/\D/g, "");
}

function bigintAPrecio(valor: bigint): number {
  if (valor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Valor excede MAX_SAFE_INTEGER: ${valor.toString()}`);
  }
  return Number(valor);
}

const PESO_SECCION = { TERCEROS: 0, OPERACIONAL: 1 } as const;

/** Líneas que viajan como ítem en el formato dado (valor > 0 y, en CONCEPTOS_IVA, sin la línea de IVA). */
export function lineasQueVanComoItem<T extends Pick<LineaParaSiigo, "valor" | "tipoFija">>(
  lineas: T[],
  formato: string,
): T[] {
  return lineas.filter(
    (l) => l.valor > 0n && !(formato === "CONCEPTOS_IVA" && l.tipoFija === "IVA_COMISION"),
  );
}

export function construirItemsSiigo(
  lineas: LineaParaSiigo[],
  opciones: OpcionesItemsSiigo,
): SiigoFacturaItemDto[] {
  const conIvaPorItem = opciones.formato === "CONCEPTOS_IVA";
  if (
    conIvaPorItem &&
    opciones.ivaTaxId === null &&
    lineas.some((l) => l.aplicaIva && !l.ivaProductoId)
  ) {
    throw new Error("Falta el impuesto IVA de Siigo para los ítems gravados");
  }

  return lineasQueVanComoItem(lineas, opciones.formato)
    .sort((a, b) => {
      const peso = PESO_SECCION[a.seccion] - PESO_SECCION[b.seccion];
      return peso !== 0 ? peso : a.orden - b.orden;
    })
    .map((l) => {
      if (!l.productoCodigo) {
        throw new Error(`La línea "${l.concepto}" no tiene producto Siigo`);
      }
      let customerNit: string | null = null;
      if (l.tipoFija === "IMPUESTO_4X1000") {
        customerNit = opciones.nit4x1000;
      } else if (l.seccion === "TERCEROS" && !l.tipoFija) {
        customerNit = l.nitTercero;
      }
      const gravado = conIvaPorItem && l.aplicaIva && l.seccion === "OPERACIONAL" && !l.tipoFija;
      // `aplicaIva` decide SI la línea lleva IVA (es lo que liquidó el motor y
      // lo que sostiene `payments.value`); el producto decide CUÁL id se manda.
      const ivaId = gravado ? (l.ivaProductoId ?? opciones.ivaTaxId) : null;

      return {
        code: l.productoCodigo,
        description: l.concepto,
        quantity: 1,
        price: bigintAPrecio(l.valor),
        ...(ivaId !== null ? { taxes: [{ id: ivaId }] } : {}),
        ...(customerNit
          ? { customer: { identification: identificacionSiigo(customerNit), branch_office: 0 } }
          : {}),
      };
    });
}
