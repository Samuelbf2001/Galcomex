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

/**
 * Puente pago↔factura (CxP v2): `monto` = cuánto de ESE pago se aplicó a ESTA
 * factura (`PagoTramiteFactura.monto`), no el valor completo del pago (un pago
 * puede cubrir varias facturas y una factura puede tener varios abonos).
 */
export type PagoTramiteFacturaInput = {
  facturaId: string;
  monto: bigint;
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
   * Lo que las líneas de la factura de venta (TERCEROS) vinculadas a esta
   * factura le cobran al cliente pasa del VALOR de la factura: se le estaría
   * cobrando más de lo que el proveedor facturó.
   */
  facturadoExcedeValor: boolean;
  /**
   * Factura NO SE COBRA (asesoría) con líneas de venta vinculadas: se le
   * estaría cobrando al cliente algo que asume Galcomex. (El editor de líneas
   * ya lo impide; esto cubre datos anteriores.)
   */
  noCobrableFacturada: boolean;
  /**
   * `true` si la fila es un problema real: desfase pagado ↔ facturado en una
   * factura que se cobra, lo facturado pasa del valor de la factura, o una
   * asesoría NO SE COBRA tiene líneas de venta. Una asesoría sin líneas
   * (`montoFacturado = 0`, lo normal) no ensucia el panel de validaciones.
   */
  esDesviacion: boolean;
};

/**
 * Cruza pagos y líneas de factura de venta por FacturaProveedor.
 *
 * - `montoPagado`   = Σ `monto` del puente PagoTramiteFactura (CxP v2: lo
 *                     aplicado a la factura, no el valor del pago)
 * - `montoFacturado`= Σ líneas vinculadas via LineaRevisionFactura
 * - `diferencia`    = montoFacturado − montoPagado  (signo positivo = facturado más de lo pagado)
 * - `facturadoExcedeValor` = montoFacturado > valor de la factura
 *
 * Un pago que cubre varias facturas cuenta en cada una solo por lo que le
 * aplicó (`monto` del puente, CxP v2), nunca por su valor completo.
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
      .reduce((sum, p) => sum + p.monto, 0n);

    const montoFacturado = lineasPivot
      .filter((l) => l.facturaId === fp.id)
      .reduce((sum, l) => sum + l.linea.valor, 0n);

    const diferencia = montoFacturado - montoPagado;
    const repercutible = fp.repercutible !== false;
    const facturadoExcedeValor = montoFacturado > fp.valor;
    const noCobrableFacturada = !repercutible && montoFacturado > 0n;

    return {
      id: fp.id,
      proveedorNombre: fp.proveedorNombre,
      numFactura: fp.numFactura,
      valor: fp.valor.toString(),
      montoPagado: montoPagado.toString(),
      montoFacturado: montoFacturado.toString(),
      diferencia: diferencia.toString(),
      repercutible,
      facturadoExcedeValor,
      noCobrableFacturada,
      esDesviacion:
        (repercutible && diferencia !== 0n) || facturadoExcedeValor || noCobrableFacturada,
    };
  });
}

/** Filas que el revisor debe mirar: descarta las que no se trasladan al cliente. */
export function desviacionesDelCruce(
  cruce: CruceFacturaProveedor[],
): CruceFacturaProveedor[] {
  return cruce.filter((fila) => fila.esDesviacion);
}
