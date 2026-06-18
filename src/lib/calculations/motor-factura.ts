/**
 * Motor de cálculo de borrador de factura — Galcomex
 * Reglas extraídas del Excel GRUPO E PAPIS 2026 (fuente de verdad).
 * Caso dorado: DO.BUN26-0026 (hoja BUN26-0026 del archivo xlsm).
 *
 * REGLAS DE NEGOCIO (sección 4 del documento de requerimientos):
 * 1. totalPagos    = Σ(valores pagos)
 * 2. costosBancarios = costoRecaudoAnticipo + Σ(costoBancario de cada pago)
 *    (en el Excel: SUM(F23:F37) + D18)
 * 3. saldoTrasPagos = anticipo − totalPagos
 * 4. impuesto4x1000 SIEMPRE SE COBRA:
 *    - Si saldo antes del 4x1000 ≥ 0 (a favor) → base = anticipo
 *    - Si saldo antes del 4x1000 < 0 (a cargo)  → base = anticipo + |saldoACargo|
 *    impuesto4x1000 = (base × tasa4x1000) / 100_000
 * 5. saldoFinal = saldoTrasPagos − comision − ivaComision − impuesto4x1000 − costosBancarios
 * 6. saldoAFavorCliente = saldoFinal − montoLM   (cuando saldoFinal > 0)
 * 7. saldoAFavorLM     = montoLM                  (cuando saldoFinal > 0)
 * 8. totalFactura      = anticipo − saldoAFavorCliente
 *
 * INVARIANTE CRÍTICA: todos los valores son BigInt (COP enteros, sin flotantes).
 * Tolerancia en tests: 0 pesos.
 */

export interface PagoInput {
  valor: bigint;
  costoBancario: bigint;
}

export interface CalculoInput {
  totalAnticipoAplicado: bigint;
  /**
   * Costo bancario del recaudo del anticipo (ej. BANCOLOMBIA = 1.950).
   * En el Excel es la celda D18. Default 0n.
   */
  costoRecaudoAnticipo?: bigint;
  pagos: PagoInput[];
  comision: bigint;         // Default 150_000n, editable por factura
  /**
   * Override explícito de IVA de la comisión.
   * En el Excel BUN26-0026 es una celda manual = 76.000 (no es 19% × comisión).
   * Si no se pasa, se calcula automáticamente como comision * tasaIva / 100n.
   */
  ivaComision?: bigint;
  tasaIva: bigint;          // Porcentaje entero (ej. 19n para 19%)
  tasa4x1000: bigint;       // Escalado /100_000 (ej. 400n = 0.004)
  /**
   * Porción del saldo final atribuible a Luis Martínez (socio).
   * Se resta del saldo a favor del cliente para obtener el saldo neto del cliente.
   * Default 0n.
   */
  montoLM?: bigint;
  /**
   * Total de retenciones (RETE IVA + RETE FTE + RETE ICA) que el cliente descuenta.
   * Efecto: reduce el totalFactura que el cliente paga → aumenta el saldoAFavorCliente.
   * Con retenciones=0n el output es bit a bit idéntico al comportamiento anterior.
   * Default 0n.
   */
  retenciones?: bigint;
}

export interface CalculoResultado {
  totalPagos: bigint;
  costosBancarios: bigint;
  /** anticipo − totalPagos (antes de comisiones e impuestos) */
  saldoTrasPagos: bigint;
  comision: bigint;
  ivaComision: bigint;
  aplica4x1000: boolean;    // true si el resultado queda A FAVOR del cliente (base = anticipo); false = a cargo (base = anticipo + |saldoACargo|)
  impuesto4x1000: bigint;
  /** saldoTrasPagos − comision − ivaComision − impuesto4x1000 − costosBancarios */
  saldoFinal: bigint;
  /** Total de retenciones aplicadas (RETE IVA + RETE FTE + RETE ICA). Mismo valor que el input. */
  retenciones: bigint;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  /** Porción del saldo final atribuible a Luis Martínez */
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
}

/**
 * Servicio puro y determinista. No toca base de datos.
 * Ejecutar dos veces con el mismo input produce el mismo output.
 *
 * Caso dorado DO.BUN26-0026 (tolerancia 0):
 *   anticipo=45.226.000, costoRecaudoAnticipo=1.950, 7 pagos,
 *   comision=200.000, ivaComision=76.000 (override), montoLM=875.944
 *   → costosBancarios=17.550, saldoTrasPagos=4.708.356,
 *     impuesto4x1000=180.904, saldoFinal=4.233.902,
 *     totalFactura=41.868.042, saldoAFavorCliente=3.357.958, saldoAFavorLM=875.944
 */
export function calcularBorrador(input: CalculoInput): CalculoResultado {
  const {
    totalAnticipoAplicado,
    costoRecaudoAnticipo = 0n,
    pagos,
    comision,
    tasaIva,
    tasa4x1000,
    montoLM = 0n,
    retenciones = 0n,
  } = input;

  // Paso 1: Σ valores y Σ costos bancarios de los pagos
  const totalPagos = pagos.reduce((sum, p) => sum + p.valor, 0n);

  // Paso 2: costos bancarios = costo del recaudo del anticipo + Σ costos de pagos
  // (Fórmula Excel: SUM(F23:F37) + D18)
  const costosBancarios =
    costoRecaudoAnticipo + pagos.reduce((sum, p) => sum + p.costoBancario, 0n);

  // Paso 3: saldo tras pagos = anticipo − totalPagos
  const saldoTrasPagos = totalAnticipoAplicado - totalPagos;

  // IVA comisión: si se pasa como override explícito (caso Excel manual), se usa tal cual.
  // Si no, se calcula como comision * tasaIva / 100n (truncado, BigInt).
  const ivaComision =
    input.ivaComision !== undefined
      ? input.ivaComision
      : (comision * tasaIva) / 100n;

  // Paso 4: 4x1000 — SIEMPRE se cobra.
  // Para determinar la base, calculamos el saldo ANTES del 4x1000.
  // Si el resultado antes del 4x1000 es ≥ 0 (a favor) → base = anticipo
  // Si el resultado es < 0 (a cargo) → base = anticipo + |saldoACargo| (fórmula Excel IF)
  const saldoAntesDe4x1000 =
    saldoTrasPagos - comision - ivaComision - costosBancarios;

  const aplica4x1000 = saldoAntesDe4x1000 >= 0n; // true = saldo a favor
  const base4x1000 = aplica4x1000
    ? totalAnticipoAplicado
    : totalAnticipoAplicado + (-saldoAntesDe4x1000);
  // Sin anticipo no hay movimiento financiero que gravar → 4x1000 = 0.
  const impuesto4x1000 =
    totalAnticipoAplicado > 0n ? (base4x1000 * tasa4x1000) / 100_000n : 0n;

  // Paso 5: saldo final
  const saldoFinal =
    saldoTrasPagos - comision - ivaComision - impuesto4x1000 - costosBancarios;

  // Pasos 6-8: distribución cliente / LM
  // Las retenciones (RETE IVA/FTE/ICA) que el cliente descuenta aumentan su saldo a favor:
  // el cliente paga menos → efectivamente recibe más dinero de vuelta.
  // Retenciones solo aplican cuando el resultado está a favor (saldoFinal >= 0).
  let saldoAFavorCliente: bigint;
  let saldoACargoCliente: bigint;
  let saldoAFavorLM: bigint;
  let saldoACargoLM: bigint;

  if (saldoFinal > 0n) {
    // A favor: el cliente recupera (saldoFinal − montoLM + retenciones); LM recupera su parte.
    // Las retenciones se suman porque reducen el pago del cliente (= Galcomex recupera menos).
    saldoAFavorCliente = saldoFinal - montoLM + retenciones;
    saldoACargoCliente = 0n;
    saldoAFavorLM = montoLM;
    saldoACargoLM = 0n;
  } else {
    // A cargo: el cliente debe; LM no aplica en este caso
    saldoAFavorCliente = 0n;
    saldoACargoCliente = -saldoFinal;
    saldoAFavorLM = 0n;
    saldoACargoLM = montoLM > 0n ? montoLM : 0n;
  }

  // Paso 8: totalFactura = anticipo − saldoAFavorCliente
  // (con retenciones: totalFactura se reduce en el monto de retenciones, replicando el Excel)
  const totalFactura = totalAnticipoAplicado - saldoAFavorCliente;

  return {
    totalPagos,
    costosBancarios,
    saldoTrasPagos,
    comision,
    ivaComision,
    aplica4x1000,
    impuesto4x1000,
    saldoFinal,
    retenciones,
    totalFactura,
    saldoAFavorCliente,
    saldoACargoCliente,
    saldoAFavorLM,
    saldoACargoLM,
  };
}

/**
 * Calcula el saldo corriente línea a línea del libro de pagos.
 * Retorna un arreglo de saldos intermedios (uno por pago, en orden).
 *
 * FIRMA INMUTABLE — A1-T6 (service.ts de pagos) depende de esta función.
 * NO cambiar parámetros ni comportamiento.
 */
export function calcularSaldosIntermedios(
  anticipo: bigint,
  pagos: Pick<PagoInput, "valor">[]
): bigint[] {
  const saldos: bigint[] = [];
  let saldo = anticipo;
  for (const pago of pagos) {
    saldo -= pago.valor;
    saldos.push(saldo);
  }
  return saldos;
}
