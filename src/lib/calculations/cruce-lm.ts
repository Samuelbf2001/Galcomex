/**
 * Cruce interno Galcomex ↔ Luis Martínez (socio Lucho) — Galcomex
 *
 * Modela la "cuenta interna de Lucho" del Excel GRUPO E PAPIS: el saldo real
 * entre Galcomex y el socio, distinto del saldo de cara al cliente.
 *
 * Dos comisiones distintas conviven en un trámite SOCIO_LM:
 *  - Comisión de FACTURA: lo que el cliente paga (va en las líneas de la factura).
 *  - Comisión INTERNA Galcomex→Lucho: la mínima (ej. 150.000), manual, que SOLO
 *    afecta este cruce interno. NO toca el saldo a favor del cliente.
 *
 * Fórmula (fuente de verdad Excel BAQ-18453, tolerancia 0):
 *   4x1000 interno = (anticipo × tasa4x1000) / 100_000   (base = anticipo: saldo a favor)
 *   saldoLMInterno = anticipo − Σpagos − comisiónInternaLM − IVA − 4x1000interno − costos
 *
 * El cruce final (saldoLM = saldoLMInterno − saldoAFavorCliente) se calcula fuera,
 * porque saldoAFavorCliente es line-driven y vive en el borrador.
 *
 * INVARIANTE: todo BigInt (COP enteros, sin flotantes). Función pura, sin BD.
 */

export interface CruceLMInput {
  /** Anticipo total aplicado al trámite. */
  totalAnticipo: bigint;
  /** Σ de los valores de los pagos a terceros. */
  totalPagos: bigint;
  /** Comisión interna Galcomex→Lucho (manual, ej. 150.000n). */
  comisionInternaLM: bigint;
  /** IVA de la comisión (mismo valor manual que la factura, ej. 76.000n). */
  ivaComision: bigint;
  /** Costos bancarios reales: recaudo del anticipo ($1.950) + Σ costos de pagos. */
  costosBancarios: bigint;
  /** Tasa 4x1000 escalada /100_000 (ej. 400n = 0.004). */
  tasa4x1000: bigint;
}

export interface CruceLMResultado {
  /** 4x1000 interno (base = anticipo). */
  impuesto4x1000Interno: bigint;
  /** Saldo de la cuenta interna con Lucho antes de cruzar con el saldo del cliente. */
  saldoLMInterno: bigint;
}

/**
 * Calcula el 4x1000 interno (base anticipo) y el saldo de la cuenta interna LM.
 *
 * Caso dorado BAQ-18453 (tolerancia 0):
 *   anticipo=35.074.500, Σpagos=32.931.686, comisiónInternaLM=150.000,
 *   IVA=76.000, costos=9.750, tasa4x1000=400
 *   → 4x1000interno=140.298, saldoLMInterno=1.766.766
 */
export function calcularSaldoLMInterno(input: CruceLMInput): CruceLMResultado {
  const {
    totalAnticipo,
    totalPagos,
    comisionInternaLM,
    ivaComision,
    costosBancarios,
    tasa4x1000,
  } = input;

  // Cuando hay saldo a favor del cliente la base del 4x1000 es el anticipo
  // (igual que el motor). Sin anticipo no hay movimiento que gravar.
  const impuesto4x1000Interno =
    totalAnticipo > 0n ? (totalAnticipo * tasa4x1000) / 100_000n : 0n;

  const saldoLMInterno =
    totalAnticipo -
    totalPagos -
    comisionInternaLM -
    ivaComision -
    impuesto4x1000Interno -
    costosBancarios;

  return { impuesto4x1000Interno, saldoLMInterno };
}
