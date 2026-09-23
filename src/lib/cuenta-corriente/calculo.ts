/**
 * Cuenta corriente por contraparte — Galcomex (M5)
 *
 * FUNCIÓN PURA, SIN BD. Misma disciplina que `motor-factura.ts`: todo el dinero
 * es `BigInt` (COP enteros) y no hay un solo flotante.
 *
 * El problema que resuelve, en palabras de la reunión: Ascinter, Coldex y
 * Eltrans son cliente y proveedor a la vez. Hoy hay que mirar dos carteras
 * distintas y cruzarlas a mano para saber cuánto se le debe realmente a cada
 * uno. Aquí se juntan las dos puntas en un solo saldo.
 *
 * CONVENCIÓN DE SIGNO — una sola, y vale para todo el módulo:
 *
 *     valor > 0  →  la empresa NOS DEBE          (saldo a cargo de la empresa)
 *     valor < 0  →  nosotros LE DEBEMOS          (saldo a favor de la empresa)
 *
 * El neto se lee igual: positivo = nos deben, negativo = les debemos, cero =
 * la cuenta está saldada.
 */

/** De dónde sale cada asiento. Fija también su signo natural. */
export type FuenteAsiento =
  | "FACTURA_VENTA" // le facturamos → nos debe
  | "ABONO_CLIENTE" // nos pagó → baja lo que nos debe
  | "DEVOLUCION_CLIENTE" // le devolvimos plata → vuelve a deber
  | "FACTURA_PROVEEDOR" // nos facturó → le debemos
  | "PAGO_PROVEEDOR" // le pagamos → baja lo que le debemos
  | "CARGO_MANUAL" // importe fuera de trámite (mensualidad Coldex)
  | "COMISION" // nos paga comisión (Eltrans) → nos debe
  | "AJUSTE"
  | "COMPENSACION"; // cruce de saldos: una punta de un cruce, con su signo

/** Punta de la cuenta a la que pertenece un asiento. */
export type RolAsiento = "CLIENTE" | "PROVEEDOR";

export interface AsientoCuenta {
  id: string;
  fuente: FuenteAsiento;
  /**
   * Punta explícita. Si falta, se deduce de la fuente (ver `rolDe`). Los
   * asientos manuales y los cruces la traen siempre.
   */
  rol?: RolAsiento;
  /** "TRAMITE" | "CLASIFICACION" | "PLAN_VALLEJO" | "COMISION" | "ASESORIA" */
  lineaServicio: string;
  concepto: string;
  fecha: Date;
  /** Signo según la convención del módulo. Nunca 0n en un asiento real. */
  valor: bigint;
  /** Referencia legible: consecutivo del DO, n° de factura, etc. */
  referencia?: string | null;
  /** Id del DO al que pertenece el asiento (si aplica), para enlazarlo en la UI. */
  tramiteId?: string | null;
  /**
   * Factura de venta a la que pertenece el asiento (si aplica) y su borrador,
   * para enlazarla en la UI con `EnlaceFacturaVenta`. Aditivo: solo lo traen
   * los asientos de `asientosComoCliente` que hablan de una factura concreta.
   */
  facturaId?: string | null;
  borradorId?: string | null;
  /** Cruce de saldos al que pertenece el asiento (las dos puntas comparten id). */
  compensacionId?: string | null;
}

export interface SaldoLinea {
  lineaServicio: string;
  /** Lo que la empresa nos debe en esta línea (siempre ≥ 0). */
  aCargo: bigint;
  /** Lo que le debemos en esta línea (siempre ≥ 0). */
  aFavor: bigint;
  /** `aCargo − aFavor`. Positivo = nos deben. */
  neto: bigint;
}

export interface ResumenCuenta {
  /** Suma bruta de todo lo que va a favor de Galcomex (≥ 0): facturas de venta, pagos hechos, comisiones. */
  totalACargo: bigint;
  /** Suma bruta de todo lo que va a favor de la empresa (≥ 0): abonos recibidos, facturas de proveedor, cargos. */
  totalAFavor: bigint;
  /** `totalACargo − totalAFavor`. Positivo = nos deben; negativo = les debemos. */
  neto: bigint;
  /**
   * Lo que la empresa todavía nos debe como cliente, neto de sus abonos
   * (negativo = le sobra plata a su favor). Es la punta que se puede cruzar.
   */
  pendienteCliente: bigint;
  /**
   * Lo que todavía le debemos como proveedor, neto de lo pagado (negativo =
   * le pagamos de más). La otra punta del cruce.
   */
  pendienteProveedor: bigint;
  /** Desglose por línea de servicio, ordenado por nombre. */
  porLinea: SaldoLinea[];
  /** Asientos ordenados de más reciente a más antiguo. */
  movimientos: AsientoCuenta[];
  /** Cuántos asientos entraron en el cálculo. */
  cantidad: number;
}

/**
 * Signo natural de cada fuente. Se aplica sobre el valor ABSOLUTO del asiento,
 * así quien construye los asientos no tiene que acordarse de la convención:
 * pasa importes positivos y la fuente decide hacia dónde suman.
 */
const SIGNO: Record<FuenteAsiento, 1n | -1n> = {
  FACTURA_VENTA: 1n,
  ABONO_CLIENTE: -1n,
  DEVOLUCION_CLIENTE: 1n,
  FACTURA_PROVEEDOR: -1n,
  PAGO_PROVEEDOR: 1n,
  CARGO_MANUAL: -1n,
  COMISION: 1n,
  AJUSTE: 1n,
  COMPENSACION: 1n,
};

/**
 * Normaliza un importe positivo al signo que le corresponde por su fuente.
 * `AJUSTE` y `COMPENSACION` son la excepción: conservan el signo que traigan,
 * porque pueden ir en cualquier dirección.
 */
export function asientoDesde(
  entrada: Omit<AsientoCuenta, "valor"> & { valor: bigint },
): AsientoCuenta {
  if (entrada.fuente === "AJUSTE" || entrada.fuente === "COMPENSACION") {
    return entrada;
  }

  const magnitud = entrada.valor < 0n ? -entrada.valor : entrada.valor;

  return { ...entrada, valor: magnitud * SIGNO[entrada.fuente] };
}

/**
 * Cruza todos los asientos de una empresa en un solo saldo.
 *
 * No filtra ni interpreta: recibe los asientos ya normalizados y suma. Quien
 * los arma decide qué entra (por ejemplo, una factura de proveedor marcada como
 * no repercutible entra igual: se le debe al proveedor aunque no se le cobre al
 * cliente).
 */
const ROL_POR_FUENTE: Record<Exclude<FuenteAsiento, "AJUSTE" | "COMPENSACION">, RolAsiento> = {
  FACTURA_VENTA: "CLIENTE",
  ABONO_CLIENTE: "CLIENTE",
  DEVOLUCION_CLIENTE: "CLIENTE",
  COMISION: "CLIENTE",
  FACTURA_PROVEEDOR: "PROVEEDOR",
  PAGO_PROVEEDOR: "PROVEEDOR",
  CARGO_MANUAL: "PROVEEDOR",
};

/** Punta del asiento: la explícita, la de su fuente o, en último caso, la que dicta su signo. */
export function rolDe(asiento: AsientoCuenta): RolAsiento {
  if (asiento.rol) return asiento.rol;
  if (asiento.fuente === "AJUSTE" || asiento.fuente === "COMPENSACION") {
    return asiento.valor >= 0n ? "CLIENTE" : "PROVEEDOR";
  }
  return ROL_POR_FUENTE[asiento.fuente];
}

export function calcularCuentaCorriente(asientos: AsientoCuenta[]): ResumenCuenta {
  const porLinea = new Map<string, { aCargo: bigint; aFavor: bigint }>();

  let totalACargo = 0n;
  let totalAFavor = 0n;
  let pendienteCliente = 0n;
  let pendienteProveedor = 0n;

  for (const asiento of asientos) {
    const linea = porLinea.get(asiento.lineaServicio) ?? { aCargo: 0n, aFavor: 0n };

    if (asiento.valor >= 0n) {
      linea.aCargo += asiento.valor;
      totalACargo += asiento.valor;
    } else {
      linea.aFavor += -asiento.valor;
      totalAFavor += -asiento.valor;
    }

    // Punta cliente: positivo = nos debe. Punta proveedor: positivo = le debemos.
    if (rolDe(asiento) === "CLIENTE") {
      pendienteCliente += asiento.valor;
    } else {
      pendienteProveedor -= asiento.valor;
    }

    porLinea.set(asiento.lineaServicio, linea);
  }

  const movimientos = [...asientos].sort(
    (a, b) => b.fecha.getTime() - a.fecha.getTime(),
  );

  return {
    totalACargo,
    totalAFavor,
    neto: totalACargo - totalAFavor,
    pendienteCliente,
    pendienteProveedor,
    porLinea: [...porLinea.entries()]
      .map(([lineaServicio, saldo]) => ({
        lineaServicio,
        aCargo: saldo.aCargo,
        aFavor: saldo.aFavor,
        neto: saldo.aCargo - saldo.aFavor,
      }))
      .sort((a, b) => a.lineaServicio.localeCompare(b.lineaServicio)),
    movimientos,
    cantidad: asientos.length,
  };
}

/** Texto corto para la UI: quién le debe a quién. */
export function describirNeto(neto: bigint, empresa: string): string {
  if (neto === 0n) return `La cuenta con ${empresa} está saldada`;
  if (neto > 0n) return `${empresa} le debe a Galcomex`;
  return `Galcomex le debe a ${empresa}`;
}

/**
 * Cuánto se puede cruzar hoy: lo que salde las dos puntas a la vez. Cero si
 * alguna punta está en cero (no hay nada contra qué cruzar).
 */
export function maximoCompensable(
  resumen: Pick<ResumenCuenta, "pendienteCliente" | "pendienteProveedor">,
): bigint {
  const cliente = resumen.pendienteCliente > 0n ? resumen.pendienteCliente : 0n;
  const proveedor = resumen.pendienteProveedor > 0n ? resumen.pendienteProveedor : 0n;
  return cliente < proveedor ? cliente : proveedor;
}

/**
 * Las dos puntas de un cruce, como asientos: en la punta cliente entra como un
 * abono (negativo: baja lo que nos deben) y en la punta proveedor como un pago
 * (positivo: baja lo que les debemos), por el mismo importe. El neto no cambia;
 * los pendientes de las dos puntas bajan.
 */
export function asientosDeCompensacion(entrada: {
  compensacionId: string;
  valor: bigint;
  fecha: Date;
  concepto: string;
  lineaServicio: string;
}): [AsientoCuenta, AsientoCuenta] {
  const magnitud = entrada.valor < 0n ? -entrada.valor : entrada.valor;
  return [
    {
      id: `compensacion-cliente:${entrada.compensacionId}`,
      fuente: "COMPENSACION",
      rol: "CLIENTE",
      lineaServicio: entrada.lineaServicio,
      concepto: `Cruce · ${entrada.concepto}`,
      fecha: entrada.fecha,
      valor: -magnitud,
      compensacionId: entrada.compensacionId,
    },
    {
      id: `compensacion-proveedor:${entrada.compensacionId}`,
      fuente: "COMPENSACION",
      rol: "PROVEEDOR",
      lineaServicio: entrada.lineaServicio,
      concepto: `Cruce · ${entrada.concepto}`,
      fecha: entrada.fecha,
      valor: magnitud,
      compensacionId: entrada.compensacionId,
    },
  ];
}
