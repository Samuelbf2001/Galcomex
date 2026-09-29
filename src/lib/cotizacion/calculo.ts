/**
 * Cotización / solicitud de fondos por DO (B7, Diseño B, 29-sep-2026) — cuenta
 * PURA, sin BD.
 *
 * Camila (nota de voz 3, 27-sep): "se les envía una cotización como si fuera
 * una solicitud de fondos y ellos con base en eso hacen la orden de compra".
 * La cotización usa LA MISMA cuenta que la factura de venta CONCEPTOS_IVA
 * (`calcularFacturaConceptos`): IVA por ítem redondeado al peso, terceros sin
 * IVA con su 4x1000 y la ReteIVA del cliente. El "total a girar" es el total de
 * la factura (sin restar anticipos: eso lo cuadra la factura, no la solicitud).
 *
 * Además calcula el "valor para su orden de compra (sin impuestos)" con la
 * regla de B4 (por defecto servicio + terceros, sin IVA, sin ReteIVA, sin
 * 4x1000; configurable por empresa en `orden_compra_en_revision`) y la nota de
 * la agencia de aduanas (la orden de compra de su agenciamiento es aparte, la
 * factura la hace la agencia: B9, solo como nota informativa).
 *
 * INTEG-B (resuelto): la regla de la OC es la MISMA del freno de B4
 * (`src/lib/borradores/orden-compra.ts`): `configOrdenCompraDe` lee la config y
 * `desgloseParaOc` + `baseParaOc` suman. Aquí solo se arma el desglose con los
 * mismos filtros que las líneas del borrador (conceptos = OPERACIONAL, terceros
 * = TERCEROS, 4x1000 = la línea fija IMPUESTO_4X1000).
 *
 * Dinero en BigInt (COP enteros), tolerancia 0.
 */

import {
  baseParaOc,
  desgloseParaOc,
  type ConfigOrdenCompra,
  type LineaParaOc,
} from "@/lib/borradores/orden-compra";
import { calcularFacturaConceptos, ivaDeItem } from "@/lib/calculations/factura-conceptos";

/** Regla de la orden de compra de la empresa (la de B4, con su `bloqueaAprobacion`, que aquí no se usa). */
export type ConfigOcCotizacion = ConfigOrdenCompra;
export type BaseOc = ConfigOrdenCompra["base"];

export interface ConceptoCotizacion {
  /** Nombre que ve el cliente (el mismo que llevará la línea de la factura). */
  concepto: string;
  /** Cómo se llegó al valor ("0,30 % del CIF…"), para el JSON; el PDF no lo imprime. */
  detalle?: string | null;
  valor: bigint;
  aplicaIva: boolean;
}

export interface TerceroCotizacion {
  concepto: string;
  valor: bigint;
  numSoporte: string | null;
}

export interface EntradaCotizacion {
  conceptos: readonly ConceptoCotizacion[];
  terceros: readonly TerceroCotizacion[];
  /** Porcentaje entero (19n). */
  tasaIva: bigint;
  /** Escalado /100_000 (400n = 0,4 %). */
  tasa4x1000: bigint;
  /** % de ReteIVA sobre el IVA; `null` = retenciones a mano (la cotización no las incluye). */
  reteIvaPorcentaje: number | null;
  configOc: ConfigOcCotizacion;
  /** Agenciamiento estándar de la agencia de aduanas del DO (`Parametro AGENCIAMIENTO_<AGENCIA>`). */
  agenciamiento: { agencia: string | null; valor: bigint | null };
}

export interface ValorParaOc {
  base: BaseOc;
  incluye4x1000: boolean;
  servicio: bigint;
  terceros: bigint;
  cuatroXMil: bigint;
  /** Lo que debe decir la orden de compra: sin IVA, sin ReteIVA. */
  valor: bigint;
}

export interface NotaAgencia {
  /** Código de la agencia (`COLDEX`). */
  agencia: string;
  valor: bigint;
  iva: bigint;
  /** valor + IVA: lo que la agencia le factura directo al cliente. */
  total: bigint;
}

export interface ResultadoCotizacion {
  conceptos: (ConceptoCotizacion & { iva: bigint })[];
  terceros: TerceroCotizacion[];
  baseConceptos: bigint;
  baseIva: bigint;
  iva: bigint;
  baseTerceros: bigint;
  impuesto4x1000: bigint;
  reteIvaPorcentaje: number | null;
  /** La empresa lleva las retenciones a mano: esta cotización no las descuenta. */
  reteIvaManual: boolean;
  retenciones: bigint;
  /** Total de la factura (sin anticipos): lo que hay que girar. */
  totalAGirar: bigint;
  valorParaOc: ValorParaOc;
  notaAgencia: NotaAgencia | null;
}

/** Nombre corto de la agencia en el texto de la nota. */
const NOMBRE_AGENCIA: Record<string, string> = {
  COLDEX: "Coldex",
  MOVIADUANAS: "Moviaduanas",
  AR_LOGISTY: "AR Logisty",
  CORTES: "Cortes",
};

export function nombreAgencia(agencia: string): string {
  return NOMBRE_AGENCIA[agencia] ?? agencia;
}

/** "Orden de compra aparte para COLDEX: 145.000 + IVA 27.550 = 172.550 (la factura la hace Coldex)". */
export function textoNotaAgencia(nota: NotaAgencia): string {
  const cop = (v: bigint) => v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Orden de compra aparte para ${nota.agencia.replace(/_/g, " ")}: ${cop(nota.valor)} + IVA ${cop(nota.iva)} = ${cop(nota.total)} (la factura la hace ${nombreAgencia(nota.agencia)})`;
}

export function armarCotizacion(entrada: EntradaCotizacion): ResultadoCotizacion {
  // Igual que `generarBorrador`: una línea sin valor no llega a la factura.
  const conceptos = entrada.conceptos.filter((c) => c.valor > 0n);
  const terceros = entrada.terceros.filter((t) => t.valor > 0n);

  const calculo = calcularFacturaConceptos({
    terceros: terceros.map((t) => t.valor),
    conceptos: conceptos.map((c) => ({ valor: c.valor, aplicaIva: c.aplicaIva })),
    tasaIva: entrada.tasaIva,
    tasa4x1000: entrada.tasa4x1000,
    reteIvaPorcentaje: entrada.reteIvaPorcentaje,
    retencionesManuales: 0n,
    totalAnticipo: 0n,
  });

  // «Valor para su OC» = la regla del freno de B4 sobre las MISMAS líneas que tendría el borrador.
  const { configOc } = entrada;
  const lineasParaOc: LineaParaOc[] = [
    ...conceptos.map((c): LineaParaOc => ({ valor: c.valor, seccion: "OPERACIONAL", tipoFija: null })),
    ...terceros.map((t): LineaParaOc => ({ valor: t.valor, seccion: "TERCEROS", tipoFija: null })),
    { valor: calculo.impuesto4x1000, seccion: "TERCEROS", tipoFija: "IMPUESTO_4X1000" },
  ];
  const desglose = desgloseParaOc(lineasParaOc);
  const valorParaOc: ValorParaOc = {
    base: configOc.base,
    incluye4x1000: configOc.incluye4x1000,
    servicio: desglose.servicio,
    terceros: desglose.terceros,
    cuatroXMil: desglose.cuatroXMil,
    valor: baseParaOc(desglose, configOc),
  };

  const { agencia, valor: valorAgencia } = entrada.agenciamiento;
  const notaAgencia: NotaAgencia | null =
    agencia && valorAgencia !== null && valorAgencia > 0n
      ? {
          agencia,
          valor: valorAgencia,
          iva: ivaDeItem(valorAgencia, entrada.tasaIva),
          total: valorAgencia + ivaDeItem(valorAgencia, entrada.tasaIva),
        }
      : null;

  return {
    conceptos: conceptos.map((c) => ({
      ...c,
      iva: c.aplicaIva ? ivaDeItem(c.valor, entrada.tasaIva) : 0n,
    })),
    terceros,
    baseConceptos: calculo.baseConceptos,
    baseIva: calculo.baseIva,
    iva: calculo.iva,
    baseTerceros: calculo.baseTerceros,
    impuesto4x1000: calculo.impuesto4x1000,
    reteIvaPorcentaje: entrada.reteIvaPorcentaje,
    reteIvaManual: entrada.reteIvaPorcentaje === null,
    retenciones: calculo.retenciones,
    totalAGirar: calculo.totalFactura,
    valorParaOc,
    notaAgencia,
  };
}
