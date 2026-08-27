/**
 * Liquidación por lotes de la cuenta corriente con el socio LM (Lucho) — Galcomex.
 *
 * Función PURA, sin BD, BigInt, tolerancia 0 pesos.
 *
 * Cada factura SOCIO_LM deja un saldo de cruce con Lucho — el `saldoNetoLM`
 * autoritativo de la factura (mismo que usa Cartera y que cuadra con el Excel):
 *   saldoLM = saldoAFavorLM − saldoACargoLM + Σabonos − Σdevoluciones   (ver [[cartera]])
 *     < 0 → Lucho le debe a Galcomex
 *     > 0 → Galcomex le debe a Lucho
 *
 * La liquidación por lotes netea todos esos saldos de un período en un único
 * número a saldar (`saldoNeto`). Galcomex ya le pagó al cliente su saldo a
 * favor; con Lucho se salda en lote, no factura a factura.
 *
 * NOTA: el saldo NO se recalcula aquí (el recálculo `saldoLMInterno −
 * saldoAFavorCliente` deriva por redondeo del 4x1000 y costos). Se consume el
 * `saldoLM` ya resuelto desde la factura para cuadrar con Cartera/Excel.
 */

export type LiquidacionItemInput = {
  /** saldoNetoLM de la factura. <0 Lucho debe; >0 Galcomex debe. */
  saldoLM: bigint;
};

export type LiquidacionLMResumen = {
  /** Σ saldoLM de todos los trámites. <0 Lucho debe a Galcomex; >0 Galcomex debe a Lucho. */
  saldoNeto: bigint;
  /** Σ |saldoLM| de los trámites donde Lucho debe (saldoLM < 0). */
  totalLuchoDebe: bigint;
  /** Σ saldoLM de los trámites donde Galcomex debe (saldoLM > 0). */
  totalGalcomexDebe: bigint;
  cantidad: number;
};

/**
 * Agrega los saldos LM de un conjunto de trámites a un resumen neteado.
 * No filtra ni ordena: opera sobre la lista tal cual la recibe.
 */
export function agregarLiquidacionLM<T extends LiquidacionItemInput>(
  items: T[],
): { items: T[]; resumen: LiquidacionLMResumen } {
  let saldoNeto = 0n;
  let totalLuchoDebe = 0n;
  let totalGalcomexDebe = 0n;

  for (const { saldoLM } of items) {
    saldoNeto += saldoLM;
    if (saldoLM < 0n) {
      totalLuchoDebe += -saldoLM;
    } else if (saldoLM > 0n) {
      totalGalcomexDebe += saldoLM;
    }
  }

  return {
    items,
    resumen: {
      saldoNeto,
      totalLuchoDebe,
      totalGalcomexDebe,
      cantidad: items.length,
    },
  };
}
