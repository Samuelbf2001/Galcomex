/**
 * Factura de venta con conceptos e IVA por ítem — formato de Galcomex propio.
 *
 * Reglas verificadas contra 331 facturas reales 2026 leídas de Siigo (Litoplas,
 * Polyrec, Polyrec ZF, CW ASIA, Sesderma, Coldex):
 *   1. Cada concepto propio es un ítem; el IVA 19 % se liquida por ítem.
 *   2. Los pagos a terceros van sin IVA, con el NIT del proveedor.
 *   3. 4x1000 = 0,4 % de la suma de terceros, redondeo al peso (195/195).
 *      Sin terceros no hay 4x1000.
 *   4. ReteIVA = % del IVA (15 % en 311/311 facturas que la llevan).
 *   5. Total = terceros + 4x1000 + conceptos + IVA − ReteIVA.
 *   6. Saldo = anticipo − total (positivo = a favor del cliente).
 *
 * Casos dorados (tolerancia 0, valores enteros):
 *   BAQ-18385 (Litoplas, DO.26-0069): terceros 502.801 + 99.484 + 486.075,
 *     conceptos 200.000 + 20.000 + 20.000 + 100.000, anticipo 1.418.000
 *     → 4x1000 4.353 · IVA 64.600 · ReteIVA 9.690 · total 1.487.623 · a cargo 69.623
 *     (la factura real lleva 0,45 de centavos de Almacarga: 1.487.623,45).
 *   BAQ-18357 (Litoplas, DO.26-0059): sin terceros, conceptos 200.000 + 80.000
 *     + 20.000 + 100.000, anticipo 476.000 → IVA 76.000 · ReteIVA 11.400 ·
 *     total 464.600 · a favor 11.400.
 *
 * INVARIANTE: todo BigInt (COP enteros). Función pura, sin BD.
 */

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

/** Redondeo al entero más cercano (mitades hacia arriba) de `numerador / divisor`, ambos ≥ 0. */
function redondear(numerador: bigint, divisor: bigint): bigint {
  return (numerador + divisor / 2n) / divisor;
}

/** IVA de un ítem, redondeado al peso como lo liquida Siigo. */
export function ivaDeItem(valor: bigint, tasaIva: bigint): bigint {
  return redondear(valor * tasaIva, 100n);
}

/** 4x1000 sobre la base de terceros, redondeado al peso. */
export function impuesto4x1000SobreTerceros(baseTerceros: bigint, tasa4x1000: bigint): bigint {
  return baseTerceros > 0n ? redondear(baseTerceros * tasa4x1000, 100_000n) : 0n;
}

/** ReteIVA como porcentaje entero del IVA, redondeada al peso. */
export function reteIvaSobre(iva: bigint, porcentaje: number): bigint {
  return redondear(iva * BigInt(porcentaje), 100n);
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
