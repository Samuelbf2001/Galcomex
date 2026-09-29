/**
 * cruce-facturas.ts — cálculo puro de desfase pagos ↔ líneas de factura de venta
 * por FacturaProveedor.
 *
 * Función pura sin BD; recibe los datos ya leídos.
 *
 * Fase centavos: todos los montos son CENTAVOS (`bigint`) de entrada y de
 * salida; la API los emite como pesos texto con 2 decimales (serializador
 * único). Nada se convierte a texto aquí.
 *
 * D-8 (fase centavos): cuando una factura pagada por el entero se re-expresa a
 * sus centavos reales (502.801 → 502.801,45), la diferencia queda cerrada con
 * un ajuste `REDONDEO`. El cruce SUMA esos ajustes a lo pagado (así no hay una
 * «desviación» falsa de $0,45) y lo dice en `nota`.
 */

import { formatoPesos, type Centavos } from "@/lib/dinero";

export type FacturaProveedorInput = {
  id: string;
  proveedorNombre: string;
  numFactura: string;
  /** Centavos. */
  valor: Centavos;
  /**
   * ¿Se traslada al cliente en la factura de venta? (M6). Ausente = `true`,
   * que es el default de la columna y el caso normal.
   */
  repercutible?: boolean;
};

/**
 * Puente pago↔factura (CxP v2): `monto` = cuánto de ESE pago se aplicó a ESTA
 * factura (`PagoTramiteFactura.montoCentavos`), no el valor completo del pago (un pago
 * puede cubrir varias facturas y una factura puede tener varios abonos).
 */
export type PagoTramiteFacturaInput = {
  facturaId: string;
  /** Centavos. */
  monto: Centavos;
};

export type LineaRevisionFacturaInput = {
  facturaId: string;
  /** Centavos. */
  linea: { valor: Centavos };
};

/**
 * Ajuste de la factura de proveedor (`AjusteFacturaProveedor`). Solo los de
 * tipo `REDONDEO` cuentan como pagado en el cruce (D-8); los demás (nota
 * crédito, retención, descuento…) no son pago y se ignoran aquí.
 */
export type AjusteFacturaInput = {
  facturaId: string;
  tipo: string;
  /** Centavos, > 0. */
  monto: Centavos;
};

export const TIPO_AJUSTE_REDONDEO = "REDONDEO";

export type CruceFacturaProveedor = {
  id: string;
  proveedorNombre: string;
  numFactura: string;
  /** Centavos. */
  valor: Centavos;
  /** Centavos: Σ lo aplicado por pagos + Σ ajustes REDONDEO (D-8). */
  montoPagado: Centavos;
  /** Centavos. */
  montoFacturado: Centavos;
  /** Centavos: montoFacturado − montoPagado. */
  diferencia: Centavos;
  /** Centavos: parte de `montoPagado` que viene de ajustes REDONDEO (0 si no hay). */
  redondeo: Centavos;
  /** «incluye redondeo de $0,45» cuando `redondeo > 0`; si no, null. */
  nota: string | null;
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

/** «incluye redondeo de $0,45» (D-8). */
export function notaRedondeo(redondeo: Centavos): string | null {
  return redondeo > 0n ? `incluye redondeo de ${formatoPesos(redondeo)}` : null;
}

/**
 * Cruza pagos y líneas de factura de venta por FacturaProveedor.
 *
 * - `montoPagado`   = Σ `monto` del puente PagoTramiteFactura (CxP v2: lo
 *                     aplicado a la factura, no el valor del pago) + Σ ajustes
 *                     `REDONDEO` de la factura (D-8)
 * - `montoFacturado`= Σ líneas vinculadas via LineaRevisionFactura
 * - `diferencia`    = montoFacturado − montoPagado  (signo positivo = facturado más de lo pagado)
 * - `facturadoExcedeValor` = montoFacturado > valor de la factura
 *
 * Un pago que cubre varias facturas cuenta en cada una solo por lo que le
 * aplicó (`monto` del puente, CxP v2), nunca por su valor completo.
 *
 * Todos los montos en CENTAVOS (`bigint`).
 */
export function calcularCruceFacturas(
  facturas: FacturaProveedorInput[],
  pagosPivot: PagoTramiteFacturaInput[],
  lineasPivot: LineaRevisionFacturaInput[],
  ajustes: AjusteFacturaInput[] = [],
): CruceFacturaProveedor[] {
  return facturas.map((fp) => {
    const aplicado = pagosPivot
      .filter((p) => p.facturaId === fp.id)
      .reduce((sum, p) => sum + p.monto, 0n);

    const redondeo = ajustes
      .filter((a) => a.facturaId === fp.id && a.tipo === TIPO_AJUSTE_REDONDEO)
      .reduce((sum, a) => sum + a.monto, 0n);

    const montoPagado = aplicado + redondeo;

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
      valor: fp.valor,
      montoPagado,
      montoFacturado,
      diferencia,
      redondeo,
      nota: notaRedondeo(redondeo),
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
