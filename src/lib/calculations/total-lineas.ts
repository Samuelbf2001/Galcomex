/**
 * Cálculo del total de la factura de venta a partir de las líneas manuales.
 * Galcomex — flujo del socio (Lucho), trámites SOCIO_LM.
 *
 * Replica el Excel de Lucho (fuente de verdad):
 *   TOTAL FACTURA = Σ(líneas "terceros", incl. 4x1000) + comisión + IVA comisión − retenciones
 *   SALDO         = ANTICIPO − TOTAL FACTURA   (positivo = a favor del cliente)
 *
 * Casos dorados verificados al peso (tolerancia 0):
 *   BAQ-18453: Σlíneas 32.652.000 + comisión 400.000 + IVA 76.000 − ret 0      = 33.128.000
 *              anticipo 35.074.500 → saldo a favor 1.946.500
 *   BAQ-18512: Σlíneas 1.159.620 + comisión 140.000 + IVA 26.600 − reteIVA 3.990 = 1.322.230
 *              anticipo 1.572.000 → saldo a favor 249.770
 *
 * INVARIANTE: todo BigInt (COP enteros, sin flotantes). Función pura, sin BD.
 *
 * NOTA: el 4x1000 NO se suma aparte — va dentro de una línea de "terceros"
 * (en el Excel de Lucho el 4x1000 es un ítem más de la sección de terceros).
 * comisión e IVA comisión son los "ingresos operacionales".
 */

export interface TotalLineasInput {
  lineas: { valor: bigint }[];
  comision: bigint;
  ivaComision: bigint;
  retenciones: bigint;
}

/** Σ(líneas) + comisión + IVA comisión − retenciones */
export function calcularTotalPorLineas(input: TotalLineasInput): bigint {
  const sumaLineas = input.lineas.reduce((sum, l) => sum + l.valor, 0n);
  return sumaLineas + input.comision + input.ivaComision - input.retenciones;
}

export interface SaldosPorLineasInput extends TotalLineasInput {
  totalAnticipo: bigint;
  /** Porción atribuible a Luis Martínez (socio). Default 0n. */
  montoLM?: bigint;
}

export interface SaldosPorLineasResultado {
  totalFacturaLineas: bigint;
  /** = totalFacturaLineas, promovido como total efectivo de la factura. */
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
}

/**
 * Calcula el total y la distribución de saldos cuando las líneas definen el total.
 * saldoFinal = totalAnticipo − totalFactura. El split montoLM replica al motor:
 * a favor → cliente recupera (saldoFinal − montoLM), LM recupera su parte.
 */
export function calcularSaldosPorLineas(
  input: SaldosPorLineasInput,
): SaldosPorLineasResultado {
  const totalFactura = calcularTotalPorLineas(input);
  const montoLM = input.montoLM ?? 0n;
  const saldoFinal = input.totalAnticipo - totalFactura;

  if (saldoFinal > 0n) {
    return {
      totalFacturaLineas: totalFactura,
      totalFactura,
      saldoAFavorCliente: saldoFinal - montoLM,
      saldoACargoCliente: 0n,
      saldoAFavorLM: montoLM,
      saldoACargoLM: 0n,
    };
  }

  return {
    totalFacturaLineas: totalFactura,
    totalFactura,
    saldoAFavorCliente: 0n,
    saldoACargoCliente: -saldoFinal,
    saldoAFavorLM: 0n,
    saldoACargoLM: montoLM,
  };
}
