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
  | "AJUSTE";

export interface AsientoCuenta {
  id: string;
  fuente: FuenteAsiento;
  /** "TRAMITE" | "CLASIFICACION" | "PLAN_VALLEJO" | "COMISION" | "ASESORIA" */
  lineaServicio: string;
  concepto: string;
  fecha: Date;
  /** Signo según la convención del módulo. Nunca 0n en un asiento real. */
  valor: bigint;
  /** Referencia legible: consecutivo del DO, n° de factura, etc. */
  referencia?: string | null;
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
  /** Suma de todo lo que la empresa nos debe (≥ 0). */
  totalACargo: bigint;
  /** Suma de todo lo que le debemos (≥ 0). */
  totalAFavor: bigint;
  /** `totalACargo − totalAFavor`. Positivo = nos deben; negativo = les debemos. */
  neto: bigint;
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
};

/**
 * Normaliza un importe positivo al signo que le corresponde por su fuente.
 * `AJUSTE` es la excepción: conserva el signo que traiga, porque un ajuste
 * puede ir en cualquier dirección.
 */
export function asientoDesde(
  entrada: Omit<AsientoCuenta, "valor"> & { valor: bigint },
): AsientoCuenta {
  if (entrada.fuente === "AJUSTE") {
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
export function calcularCuentaCorriente(asientos: AsientoCuenta[]): ResumenCuenta {
  const porLinea = new Map<string, { aCargo: bigint; aFavor: bigint }>();

  let totalACargo = 0n;
  let totalAFavor = 0n;

  for (const asiento of asientos) {
    const linea = porLinea.get(asiento.lineaServicio) ?? { aCargo: 0n, aFavor: 0n };

    if (asiento.valor >= 0n) {
      linea.aCargo += asiento.valor;
      totalACargo += asiento.valor;
    } else {
      linea.aFavor += -asiento.valor;
      totalAFavor += -asiento.valor;
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
