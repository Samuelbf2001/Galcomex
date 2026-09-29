/**
 * Factura de venta con conceptos e IVA por ítem — formato de Galcomex propio.
 *
 * Reglas verificadas contra 331 facturas reales 2026 leídas de Siigo (Litoplas,
 * Polyrec, Polyrec ZF, CW ASIA, Sesderma, Coldex):
 *   1. Cada concepto propio es un ítem; el IVA 19 % se liquida por ítem, AL CENTAVO.
 *   2. Los pagos a terceros van sin IVA, con el NIT del proveedor.
 *   3. 4x1000 = 0,4 % de la suma de terceros, redondeo al peso (195/195).
 *      Sin terceros no hay 4x1000.
 *   4. ReteIVA = % del IVA (15 % en 311/311 facturas que la llevan), AL CENTAVO.
 *   5. Total = terceros + 4x1000 + conceptos + IVA − ReteIVA.
 *   6. Saldo = anticipo − total (positivo = a favor del cliente).
 *
 * Casos dorados (tolerancia 0, en CENTAVOS desde la fase centavos):
 *   FV-2-18702 (Siigo, 2026-08-17): ítem 6.632.007 → IVA 1.260.081,33; IVA total
 *     1.546.259,33 → ReteIVA 15 % 231.938,90; total 10.209.744,43.
 *   FV-2-18772 (Siigo, 2026-09-11): terceros 1.543.450 → 4x1000 6.174 (6.173,80 al
 *     peso); IVA 208.050 → ReteIVA 31.207,50; total 2.821.466,50.
 *   BAQ-18385 (Litoplas, DO.26-0069): terceros 502.801,45 + 99.484 + 486.075,
 *     conceptos 200.000 + 20.000 + 20.000 + 100.000, anticipo 1.418.000
 *     → 4x1000 4.353 (0,4 % de 1.088.360,45 = 4.353,44 → al peso) · IVA 64.600 ·
 *     ReteIVA 9.690 · total 1.487.623,45 · a cargo 69.623,45
 *     (en centavos: 148.762.345 / 6.962.345; igual que la factura real de Siigo).
 *   BAQ-18357 (Litoplas, DO.26-0059): sin terceros, conceptos 200.000 + 80.000
 *     + 20.000 + 100.000, anticipo 476.000 → IVA 76.000 · ReteIVA 11.400 ·
 *     total 464.600 · a favor 11.400.
 *
 * Redondeo (diseño A.6, D-1 corregida por evidencia el 2026-09-24): terceros y
 * totales exactos al centavo; IVA por ítem y ReteIVA AL CENTAVO (así los liquida
 * Siigo: 16 ítems y 107 ReteIVA de 2026 con centavos, 0 al peso); 4x1000 AL PESO
 * (49/49). Todo mitad hacia arriba, vía `porcentajeDe` del núcleo (un solo
 * redondeo). Las precisiones se exportan para que Siigo (`items-factura.ts`) y
 * las pantallas usen exactamente las mismas.
 *
 * INVARIANTE: todo BigInt en CENTAVOS de COP. Función pura, sin BD.
 */

import { enteroNoDinero, porcentajeDe, type Centavos } from "@/lib/dinero";

/** Precisión de redondeo de un porcentaje de dinero (`porcentajeDe` del núcleo). */
export type PrecisionDinero = "CENTAVO" | "PESO";

/**
 * D-1: precisión del IVA por ítem. AL CENTAVO, como lo liquida Siigo
 * (FV-2-18702: 6.632.007 × 19 % = 1.260.081,33). La usa también el invariante
 * de cuadre del envío a Siigo (`PRECISION_IVA_SIIGO`).
 */
export const PRECISION_IVA: PrecisionDinero = "CENTAVO";

/** D-1: precisión de la ReteIVA. AL CENTAVO (FV-2-18772: 15 % de 208.050 = 31.207,50). */
export const PRECISION_RETEIVA: PrecisionDinero = "CENTAVO";

/** A.6: precisión del 4x1000 de la factura (Σ terceros). AL PESO (BAQ-18385: 4.353,44 → 4.353). */
export const PRECISION_4X1000_FACTURA: PrecisionDinero = "PESO";

export interface ConceptoFactura {
  valor: bigint;
  aplicaIva: boolean;
}

export interface FacturaConceptosInput {
  /** Valores de las líneas de terceros (sin la línea del 4x1000). */
  terceros: bigint[];
  /** Líneas de ingresos propios (sin la línea de IVA). */
  conceptos: ConceptoFactura[];
  /** Porcentaje entero, ej. 19n. */
  tasaIva: bigint;
  /** Escalado /100_000, ej. 400n = 0,4 %. */
  tasa4x1000: bigint;
  /** % de ReteIVA sobre el IVA; null = se usa `retencionesManuales`. */
  reteIvaPorcentaje: number | null;
  retencionesManuales: bigint;
  totalAnticipo: bigint;
}

export interface FacturaConceptosResultado {
  baseTerceros: bigint;
  impuesto4x1000: bigint;
  baseConceptos: bigint;
  baseIva: bigint;
  iva: bigint;
  retenciones: bigint;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
}

/** IVA de un ítem (centavos), redondeado AL CENTAVO, mitad arriba, como lo liquida Siigo (D-1). */
export function ivaDeItem(valor: Centavos, tasaIva: bigint): Centavos {
  return porcentajeDe(valor, tasaIva, 100n, { precision: PRECISION_IVA });
}

/**
 * 4x1000 sobre la base de terceros (centavos), redondeado AL PESO, mitad arriba.
 * BAQ-18385: 108.836.045 → 435.300 (4.353,44 → 4.353); BAQ-18453: 3.252.191.200 → 13.008.800.
 */
export function impuesto4x1000SobreTerceros(baseTerceros: Centavos, tasa4x1000: bigint): Centavos {
  return baseTerceros > 0n
    ? porcentajeDe(baseTerceros, tasa4x1000, 100_000n, { precision: PRECISION_4X1000_FACTURA })
    : 0n;
}

/** ReteIVA como porcentaje entero del IVA total (centavos), redondeada AL CENTAVO, mitad arriba (D-1). */
export function reteIvaSobre(iva: Centavos, porcentaje: number): Centavos {
  return porcentajeDe(iva, enteroNoDinero(porcentaje), 100n, { precision: PRECISION_RETEIVA });
}

export function calcularFacturaConceptos(input: FacturaConceptosInput): FacturaConceptosResultado {
  const baseTerceros = input.terceros.reduce((s, v) => s + v, 0n);
  const impuesto4x1000 = impuesto4x1000SobreTerceros(baseTerceros, input.tasa4x1000);

  const baseConceptos = input.conceptos.reduce((s, c) => s + c.valor, 0n);
  const gravados = input.conceptos.filter((c) => c.aplicaIva);
  const baseIva = gravados.reduce((s, c) => s + c.valor, 0n);
  const iva = gravados.reduce((s, c) => s + ivaDeItem(c.valor, input.tasaIva), 0n);

  const retenciones =
    input.reteIvaPorcentaje === null
      ? input.retencionesManuales
      : reteIvaSobre(iva, input.reteIvaPorcentaje);

  const totalFactura = baseTerceros + impuesto4x1000 + baseConceptos + iva - retenciones;
  const saldo = input.totalAnticipo - totalFactura;

  return {
    baseTerceros,
    impuesto4x1000,
    baseConceptos,
    baseIva,
    iva,
    retenciones,
    totalFactura,
    saldoAFavorCliente: saldo > 0n ? saldo : 0n,
    saldoACargoCliente: saldo < 0n ? -saldo : 0n,
  };
}
