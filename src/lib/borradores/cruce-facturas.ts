/**
 * cruce-facturas.ts — cálculo puro de desfase pagos ↔ líneas de factura de venta
 * por FacturaProveedor.
 *
 * Función pura sin BD; recibe los datos ya leídos.
 */

export type FacturaProveedorInput = {
  id: string;
  proveedorNombre: string;
  numFactura: string;
  valor: bigint;
  /**
   * ¿Se traslada al cliente en la factura de venta? (M6). Ausente = `true`,
   * que es el default de la columna y el caso normal.
   */
  repercutible?: boolean;
};

export type PagoTramiteFacturaInput = {
  facturaId: string;
  pago: { valor: bigint };
};

export type LineaRevisionFacturaInput = {
  facturaId: string;
  linea: { valor: bigint };
};

export type CruceFacturaProveedor = {
  id: string;
  proveedorNombre: string;
  numFactura: string;
  valor: string;
  montoPagado: string;
  montoFacturado: string;
  diferencia: string;
  /** Copia del flag de la factura, para que la UI pueda etiquetarla. */
  repercutible: boolean;
  /**
   * `true` solo si la diferencia es un problema real. Una factura que NO se
   * traslada al cliente (asesoría a nombre de Galcomex) siempre tiene
   * `montoFacturado = 0` y no debe ensuciar el panel de validaciones.
   */
  esDesviacion: boolean;
};

/**
 * Cruza pagos y líneas de factura de venta por FacturaProveedor.
 *
 * - `montoPagado`   = Σ pagos vinculados via PagoTramiteFactura
 * - `montoFacturado`= Σ líneas vinculadas via LineaRevisionFactura
 * - `diferencia`    = montoFacturado − montoPagado  (signo positivo = facturado más de lo pagado)
 *
 * Todos los valores se devuelven como strings (BigInt serializado).
 */
export function calcularCruceFacturas(
  facturas: FacturaProveedorInput[],
  pagosPivot: PagoTramiteFacturaInput[],
  lineasPivot: LineaRevisionFacturaInput[],
): CruceFacturaProveedor[] {
  return facturas.map((fp) => {
    const montoPagado = pagosPivot
      .filter((p) => p.facturaId === fp.id)
      .reduce((sum, p) => sum + p.pago.valor, 0n);

    const montoFacturado = lineasPivot
      .filter((l) => l.facturaId === fp.id)
      .reduce((sum, l) => sum + l.linea.valor, 0n);

    const diferencia = montoFacturado - montoPagado;
    const repercutible = fp.repercutible !== false;

    return {
      id: fp.id,
      proveedorNombre: fp.proveedorNombre,
      numFactura: fp.numFactura,
      valor: fp.valor.toString(),
      montoPagado: montoPagado.toString(),
      montoFacturado: montoFacturado.toString(),
      diferencia: diferencia.toString(),
      repercutible,
      esDesviacion: repercutible && diferencia !== 0n,
    };
  });
}

/** Filas que el revisor debe mirar: descarta las que no se trasladan al cliente. */
export function desviacionesDelCruce(
  cruce: CruceFacturaProveedor[],
): CruceFacturaProveedor[] {
  return cruce.filter((fila) => fila.esDesviacion);
}
