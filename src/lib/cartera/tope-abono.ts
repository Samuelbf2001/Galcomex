/**
 * Tope del abono — decisión de Ernesto del 25-sep-2026 («Tema 1 – A»).
 *
 * Un abono no puede pasar de lo que se debe de la factura. Si el cliente pagó
 * de más, el sobrante NO queda como «pendiente de devolver» (así un valor mal
 * digitado mostraba una devolución de plata que nunca entró): se guarda aparte
 * como anticipo del cliente para su próximo DO, y solo cuando quien registra
 * lo confirma (`excedenteComoAnticipo`).
 *
 * Función pura, sin BD. El servicio de cartera la usa dentro de la
 * transacción, con el saldo neto leído bajo el advisory lock de la factura.
 */

export type RepartoAbono = {
  /** Lo que la factura tenía pendiente de cobro antes del abono (≥ 0). */
  pendiente: bigint;
  /** Parte del abono que se aplica a la factura (nunca pasa del pendiente). */
  aLaFactura: bigint;
  /** Lo que sobra (0 si el abono cabe en el pendiente). */
  excedente: bigint;
};

/**
 * Reparte un abono entre la factura y el sobrante.
 *
 * `saldoNetoActual` usa la convención del ledger (`calcularSaldoNeto`):
 * negativo = la parte le debe a Galcomex, así que el pendiente de cobro es su
 * valor absoluto; 0 o positivo = no hay nada que cobrar.
 */
export function repartirAbono(saldoNetoActual: bigint, monto: bigint): RepartoAbono {
  const pendiente = saldoNetoActual < 0n ? -saldoNetoActual : 0n;
  const aLaFactura = monto < pendiente ? monto : pendiente;

  return { pendiente, aLaFactura, excedente: monto - aLaFactura };
}

/** Código estable del rechazo cuando el abono supera lo que se debe. */
export const CODIGO_ABONO_EXCEDE_SALDO = "ABONO_EXCEDE_SALDO" as const;
