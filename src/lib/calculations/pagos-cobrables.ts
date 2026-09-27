/**
 * Parte cobrable de los pagos del trámite — Galcomex
 *
 * Un pago del libro (PagoTramite) puede estar enlazado a facturas de proveedor
 * por el puente PagoTramiteFactura. Si la factura NO se le cobra al cliente
 * (FacturaProveedor.repercutible = false, badge «NO SE COBRA»; caso Ascinter:
 * la asesoría), lo que Galcomex paga por ella es un costo interno: no puede
 * entrar en el total de pagos del borrador, ni en sus costos bancarios, ni en
 * la base del 4x1000. El cliente nunca debe pagar un peso derivado de ella.
 *
 * Este módulo decide, pago por pago, qué parte se le cobra al cliente. Su
 * salida entra tal cual al motor (`calcularBorrador`), que NO cambia: los
 * pagos sueltos y los 100 % repercutibles pasan bit a bit como antes, así que
 * los casos dorados (BUN26-0026, DOs de Lucho) siguen dando lo mismo.
 *
 * REGLAS (en este orden):
 * R1. Pago sin facturas enlazadas (suelto: histórico, Lucho) → completo.
 * R2. Todas las facturas enlazadas se cobran → completo (identidad: un pago
 *     mayor o menor que sus facturas se cobra igual que hoy).
 * R3. Alguna factura enlazada NO se cobra → «primero lo no cobrable, y nunca
 *     más de lo que suman las facturas que se cobran»:
 *       tope NO SE COBRA = Σ peso de las facturas NO SE COBRA
 *       tope cobrable    = Σ peso de las facturas que se cobran
 *       cobrable         = min(pago.valor − min(pago.valor, tope NO SE COBRA),
 *                              tope cobrable)
 *       noCobrable       = pago.valor − cobrable
 *     (peso = lo que el pago abona a esa factura; ver `pesosDeEnlaces`).
 *     - Solo asesoría → 0 cobrable SIEMPRE (tope cobrable = 0), aunque el pago
 *       sea mayor que la asesoría: el sobrante lo asume Galcomex.
 *     - Pago igual a la suma de sus facturas (el caso normal del pago en
 *       bloque) → lo mismo que un prorrateo exacto, sin división ni residuo.
 *     - Abono parcial del transporte (pago < suma de sus facturas): la
 *       asesoría se descuenta completa y el resto es transporte.
 *     - Pago mayor que sus facturas: el sobrante NO se le cobra al cliente
 *       (DECISIÓN: contra Galcomex, coherente con «el cliente nunca»); el pago
 *       queda marcado para revisar por si el sobrante era transporte.
 *     Sin montos por enlace (hoy: pagos manuales, históricos o bloques cuya
 *     auditoría no identifica el monto sin ambigüedad) se descuenta la
 *     asesoría por el valor de su factura, y el reparto es inexacto cuando en
 *     ESTE pago la asesoría no recibió exactamente ese valor. El error puede ir
 *     en los dos sentidos:
 *       · contra Galcomex (al cliente se le cobra de menos) si la asesoría no
 *         se pagó completa en este pago: abonada en parte en un pago anterior
 *         (se descuenta completa otra vez), abonada en parte en este mismo
 *         pago (p. ej. neta de retención), o varios pagos que abonan cada uno
 *         una parte de las mismas facturas;
 *       · contra el CLIENTE (se le cobra de más) si a la asesoría se le pagó
 *         en este pago más de lo que dice su factura (p. ej. con IVA) y el
 *         transporte no se pagó completo: lo pagado de más a la asesoría se
 *         toma como transporte.
 *     Si el valor del pago no cuadra con sus facturas, el pago sale en
 *     `porRevisar` (ABONO_PARCIAL si es menor, SOBRANTE_NO_COBRADO si es
 *     mayor) y hay que mirar cuánto fue a cada factura. La única ambigüedad
 *     que `desglosarPago` no puede detectar es una asesoría pagada DE MÁS
 *     compensada con un transporte pagado de menos por el mismo valor (el
 *     pago cuadra con la suma): ahí se supone que cada factura se pagó
 *     completa y la diferencia se le cobra al cliente.
 *     Para el pago en bloque ese hueco lo cierra `prepararPagosParaCobro`: si
 *     la auditoría no le da montos, la asesoría pesa lo MAYOR entre su factura
 *     y lo que algún bloque le abonó según la auditoría, y el pago queda por
 *     revisar (`bloqueSinMontos`).
 *     Con montos por enlace (`monto`: PagoTramiteFactura.monto de CxP v2, que
 *     manda SIEMPRE que el pago lo tenga y no sea una estimación de la
 *     migración; o, solo para enlaces heredados, los recuperados de la
 *     auditoría del pago en bloque con `montosDeBloquesAuditados`) el reparto
 *     es exacto. Los montos de un pago MIXTO heredado (`montosSonEstimados`:
 *     algún enlace no lo aplicó CxP v2) los puso la migración y no mandan: ese
 *     pago se reparte como si no los tuviera (heurística de arriba + marca).
 *     Costo bancario: completo si cobrable ≠ 0 (DECISIÓN A: la transferencia
 *     existiría igual solo por lo que se cobra); 0 si cobrable = 0 (la
 *     transferencia de un pago de solo asesoría la asume Galcomex).
 *
 * INVARIANTE CRÍTICA: todos los valores son BigInt (COP enteros, sin flotantes).
 * `cobrable + noCobrable === pago.valor` siempre, con 0 ≤ noCobrable, y con
 * alguna factura NO SE COBRA: 0 ≤ cobrable ≤ Σ peso de las que se cobran.
 */

import type { PagoInput } from "./motor-factura";

/** Una factura de proveedor enlazada al pago (fila de PagoTramiteFactura). */
export interface EnlaceFacturaCobro {
  /** FacturaProveedor.valor (COP). */
  valorFactura: bigint;
  /** FacturaProveedor.repercutible: ¿se le cobra al cliente? */
  repercutible: boolean;
  /**
   * Lo que este pago abona a esta factura: PagoTramiteFactura.monto de CxP v2
   * o, para un enlace heredado sin monto (0 en todos los enlaces del pago), el
   * monto que el pago en bloque dejó en la auditoría
   * (`montosDeBloquesAuditados`). Ausente = desconocido.
   */
  monto?: bigint | null;
}

/** Un pago del libro con sus facturas enlazadas. */
export interface PagoParaCobro {
  valor: bigint;
  costoBancario: bigint;
  /** Facturas enlazadas. Vacío = pago suelto (R1). */
  facturas: readonly EnlaceFacturaCobro[];
}

/** Lo que del pago se le cobra al cliente (mismo formato que `PagoInput`). */
export interface ParteCobrable {
  valor: bigint;
  costoBancario: bigint;
}

/** Desglose completo de un pago: lo que se cobra, lo que no y si hay que revisarlo. */
export interface DesglosePago {
  /** Lo que se le cobra al cliente (entra al motor). */
  cobrable: ParteCobrable;
  /** Valor que NO se le cobra (lo asume Galcomex). cobrable.valor + noCobrable = pago.valor. */
  noCobrable: bigint;
  /** Σ pesos de todas las facturas enlazadas (monto por enlace o valor de la factura). */
  sumaFacturas: bigint;
  /**
   * El pago toca facturas NO SE COBRA y su valor no coincide con la suma de sus
   * facturas, así que el sistema no puede saber con certeza qué parte fue
   * asesoría:
   * - valor > suma: el sobrante lo asume Galcomex (¿era transporte sin
   *   factura enlazada?), o
   * - mixto con valor < suma: abono parcial; si la asesoría no se pagó
   *   completa en este pago, Galcomex deja de recobrar parte del transporte
   *   (al cliente se le cobra de menos), y si a la asesoría se le pagó más
   *   de lo que dice su factura, ese exceso se le cobra al cliente como
   *   transporte (se le cobra de más).
   * Un pago de solo asesoría menor que la asesoría es exacto (0 cobrable) y no
   * se marca.
   */
  porRevisar: boolean;
}

function suma(valores: readonly bigint[]): bigint {
  return valores.reduce((acc, v) => acc + v, 0n);
}

function minimo(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maximo(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Peso de cada enlace = lo que el pago abona a esa factura.
 *
 * - Si TODOS los enlaces traen `monto` ≥ 0 y Σmonto > 0 → el monto (exacto:
 *   un monto 0 significa que este pago no abona nada a esa factura).
 * - Si no → el valor de la factura (tope de lo que el pago le puede abonar).
 *   Una factura NO SE COBRA con valor ≤ 0 no tiene peso conocido → `null`
 *   (defensivo: hoy es imposible porque zod exige valor > 0), y entonces el
 *   pago completo se trata como no cobrable (el error va contra Galcomex).
 *   Una factura que se cobra con valor ≤ 0 pesa 0 (tampoco sube el tope de lo
 *   cobrable: el error también va contra Galcomex).
 */
function pesosDeEnlaces(facturas: readonly EnlaceFacturaCobro[]): (bigint | null)[] {
  const montos = facturas.map((f) => f.monto);
  if (montos.every((m): m is bigint => m != null && m >= 0n) && suma(montos) > 0n) {
    return montos;
  }
  return facturas.map((f) => {
    if (f.valorFactura > 0n) return f.valorFactura;
    return f.repercutible ? 0n : null;
  });
}

/**
 * Desglose de un pago en lo que se cobra y lo que no. Puro y determinista.
 *
 * Ej. (R3): pago 800.000 con costo 3.900 que abona 500.000 al transporte
 * (factura de 1.000.000, se cobra) y paga la asesoría de 300.000 (no se
 * cobra) → cobrable { 500.000, 3.900 }, noCobrable 300.000, porRevisar
 * (mixto con valor menor que la suma de sus facturas).
 * Ej. (sobrante): pago 357.000 enlazado solo a una asesoría de 300.000 →
 * cobrable { 0, 0 }, noCobrable 357.000, porRevisar.
 */
export function desglosarPago(pago: PagoParaCobro): DesglosePago {
  const { valor, costoBancario, facturas } = pago;

  // R1: pago suelto → como siempre.
  if (facturas.length === 0) {
    return { cobrable: { valor, costoBancario }, noCobrable: 0n, sumaFacturas: 0n, porRevisar: false };
  }

  const pesos = pesosDeEnlaces(facturas);
  const sumaFacturas = suma(pesos.map((p) => p ?? 0n));

  // R2: todo se cobra → identidad.
  if (facturas.every((f) => f.repercutible)) {
    return { cobrable: { valor, costoBancario }, noCobrable: 0n, sumaFacturas, porRevisar: false };
  }

  // R3: primero lo no cobrable, y lo cobrable nunca pasa de lo que suman las
  // facturas que se cobran. Un peso desconocido (null) de una factura NO SE
  // COBRA absorbe el pago completo.
  const pesosNoCobrables = pesos.filter((_, i) => !facturas[i].repercutible);
  const topeNoCobrable = pesosNoCobrables.some((p) => p === null)
    ? valor
    : suma(pesosNoCobrables.map((p) => p ?? 0n));
  const topeCobrable = suma(pesos.filter((_, i) => facturas[i].repercutible).map((p) => p ?? 0n));

  // valor ≤ 0 no aporta nada que repartir (valor < 0 es imposible: zod ≥ 0;
  // pasaría tal cual, como un pago suelto, lo que tampoco perjudica al cliente).
  const valorCobrable =
    valor <= 0n ? valor : minimo(valor - minimo(valor, topeNoCobrable), topeCobrable);
  const noCobrable = valor - valorCobrable;

  const hayRepercutible = facturas.some((f) => f.repercutible);
  const porRevisar = valor > sumaFacturas || (hayRepercutible && valor < sumaFacturas);

  return {
    cobrable: {
      valor: valorCobrable,
      // DECISIÓN A: con algo cobrable, la transferencia va completa; sin nada
      // cobrable, la asume Galcomex. (Alternativa B, prorratear:
      // `(costoBancario * valorCobrable) / valor`.)
      costoBancario: valorCobrable === 0n ? 0n : costoBancario,
    },
    noCobrable,
    sumaFacturas,
    porRevisar,
  };
}

/** Parte del pago que se le cobra al cliente (atajo de `desglosarPago`). */
export function parteCobrableDePago(pago: PagoParaCobro): ParteCobrable {
  return desglosarPago(pago).cobrable;
}

/**
 * Pagos listos para el motor: 1 a 1 y en el mismo orden que la entrada,
 * cada uno reducido a su parte cobrable.
 */
export function pagosCobrablesParaMotor(pagos: readonly PagoParaCobro[]): PagoInput[] {
  return pagos.map((p) => parteCobrableDePago(p));
}

// ─── Montos del pago en bloque recuperados de la auditoría ───────────────────
// Solo para enlaces HEREDADOS sin monto: con CxP v2 cada enlace guarda su
// PagoTramiteFactura.monto (la migración lo llenó desde esta misma auditoría y,
// si no pudo, lo dejó en 0) y ese monto manda siempre. El pago en bloque
// (`crearPagoMultiDO`) crea UN PagoTramite por DO con valor = Σ montos y deja,
// por cada factura, una fila de auditoría FacturaProveedor/UPDATE_ESTADO con
// `antes.montoPagadoEnGrupo` = lo que el bloque le abonó. Esa fila no dice a
// qué pago pertenece, así que solo se usa cuando la asignación es inequívoca.

/** Un pago del libro visto para recuperar sus montos por factura. */
export interface PagoConEnlaces {
  id: string;
  valor: bigint;
  /** No nulo = el pago salió de un pago en bloque. */
  grupoPagoId: string | null;
  facturaIds: readonly string[];
}

/** Fila de auditoría del pago en bloque: lo que el bloque le abonó a una factura. */
export interface AbonoBloqueAuditado {
  facturaId: string;
  monto: bigint;
}

/**
 * Lee `antes.montoPagadoEnGrupo` de una fila de auditoría UPDATE_ESTADO de una
 * factura de proveedor. `null` si no es una fila del pago en bloque o si el
 * monto no es un entero positivo.
 */
export function montoPagadoEnGrupoDeAuditoria(antes: unknown): bigint | null {
  if (typeof antes !== "object" || antes === null || Array.isArray(antes)) return null;
  const crudo = (antes as Record<string, unknown>).montoPagadoEnGrupo;
  let monto: bigint | null = null;
  if (typeof crudo === "string" && /^\d+$/.test(crudo)) monto = BigInt(crudo);
  else if (typeof crudo === "number" && Number.isSafeInteger(crudo)) monto = BigInt(crudo);
  return monto !== null && monto > 0n ? monto : null;
}

/**
 * Montos por enlace (pagoId → facturaId → monto) de los pagos en bloque cuya
 * asignación en la auditoría es inequívoca. Pura y determinista.
 *
 * Un pago recibe montos solo si:
 * 1. salió de un pago en bloque (`grupoPagoId` no nulo) y tiene facturas;
 * 2. para CADA factura enlazada, la auditoría tiene tantas filas como enlaces
 *    de bloque tiene la factura en el libro, y todas con el mismo monto (así
 *    da igual qué fila corresponde a qué pago; una fila de más, p. ej. de un
 *    bloque eliminado, lo vuelve ambiguo y se descarta);
 * 3. Σ montos = valor del pago (si alguien editó el valor, se descarta).
 * Si algo no cumple, el pago no recibe montos y se reparte por el valor de
 * las facturas (ver `desglosarPago`; para un bloque con asesoría,
 * `prepararPagosParaCobro` sube además el peso de la asesoría y lo marca).
 */
export function montosDeBloquesAuditados(
  pagos: readonly PagoConEnlaces[],
  abonos: readonly AbonoBloqueAuditado[],
): Map<string, Map<string, bigint>> {
  const abonosPorFactura = new Map<string, bigint[]>();
  for (const a of abonos) {
    const lista = abonosPorFactura.get(a.facturaId) ?? [];
    lista.push(a.monto);
    abonosPorFactura.set(a.facturaId, lista);
  }

  const pagosEnBloque = pagos.filter((p) => p.grupoPagoId !== null && p.facturaIds.length > 0);
  const enlacesDeBloquePorFactura = new Map<string, number>();
  for (const p of pagosEnBloque) {
    for (const facturaId of p.facturaIds) {
      enlacesDeBloquePorFactura.set(facturaId, (enlacesDeBloquePorFactura.get(facturaId) ?? 0) + 1);
    }
  }

  const resultado = new Map<string, Map<string, bigint>>();
  for (const p of pagosEnBloque) {
    const montos = new Map<string, bigint>();
    for (const facturaId of p.facturaIds) {
      const lista = abonosPorFactura.get(facturaId) ?? [];
      const inequivoco =
        lista.length > 0 &&
        lista.length === enlacesDeBloquePorFactura.get(facturaId) &&
        lista.every((m) => m === lista[0]);
      if (!inequivoco) break;
      montos.set(facturaId, lista[0]);
    }
    if (montos.size !== p.facturaIds.length) continue;
    if (suma([...montos.values()]) !== p.valor) continue;
    resultado.set(p.id, montos);
  }
  return resultado;
}

// ─── Pagos del libro listos para `desglosarPago` ─────────────────────────────

/** Una factura enlazada a un pago del libro, tal como sale de la BD. */
export interface EnlaceDelLibro {
  facturaId: string;
  /** FacturaProveedor.valor (COP). */
  valorFactura: bigint;
  /** FacturaProveedor.repercutible: ¿se le cobra al cliente? */
  repercutible: boolean;
  /**
   * PagoTramiteFactura.monto (CxP v2): cuánto de ESTE pago se aplicó a esta
   * factura. 0 en todos los enlaces del pago = enlace heredado que la migración
   * no pudo repartir. Ausente = sin dato.
   */
  monto?: bigint | null;
}

/** Un pago del libro con sus facturas enlazadas, tal como sale de la BD. */
export interface PagoDelLibro {
  id: string;
  valor: bigint;
  costoBancario: bigint;
  /** No nulo = el pago salió de un pago en bloque. */
  grupoPagoId: string | null;
  facturas: readonly EnlaceDelLibro[];
  /**
   * Los montos por enlace de este pago los ESTIMÓ la migración de CxP v2 (ver
   * `montosSonEstimados`): no son un dato y no mandan. Ausente = no.
   */
  montosEstimados?: boolean;
}

/** Entrada de `desglosarPago` de un pago del libro. */
export interface PagoPreparado {
  paraCobro: PagoParaCobro;
  /**
   * Pago en bloque con asesoría al que la auditoría no le pudo dar montos por
   * factura (ambigua: p. ej. un bloque eliminado y rehecho, o un valor
   * editado). Su reparto es una suposición: siempre va a `pagosPorRevisar`.
   */
  bloqueSinMontos: boolean;
}

/** ¿Salió de un pago en bloque y toca alguna factura NO SE COBRA? */
export function esBloqueConAsesoria(
  pago: Pick<PagoDelLibro, "grupoPagoId" | "facturas">,
): boolean {
  return pago.grupoPagoId !== null && pago.facturas.some((f) => !f.repercutible);
}

/**
 * ¿El pago trae montos por enlace de CxP v2 (PagoTramiteFactura.monto)? Sí si
 * tiene facturas, todos sus enlaces traen `monto` ≥ 0 y suman más de 0 (un
 * enlace en 0 junto a otros con monto = este pago no le abonó nada a esa
 * factura). Con montos v2 el reparto es exacto y la auditoría no se consulta.
 */
export function tieneMontosPorEnlace(pago: Pick<PagoDelLibro, "facturas">): boolean {
  const montos = pago.facturas.map((f) => f.monto);
  return (
    montos.length > 0 &&
    montos.every((m): m is bigint => m != null && m >= 0n) &&
    suma(montos) > 0n
  );
}

/** ¿El pago toca a la vez facturas que se cobran y facturas NO SE COBRA? */
export function esPagoMixto(pago: Pick<PagoDelLibro, "facturas">): boolean {
  return pago.facturas.some((f) => f.repercutible) && pago.facturas.some((f) => !f.repercutible);
}

/** Llave de un enlace pago ↔ factura en `enlacesAplicadosEnV2`. */
export function llaveEnlace(pagoId: string, facturaId: string): string {
  return `${pagoId}|${facturaId}`;
}

/**
 * Enlaces pago ↔ factura que aplicó CxP v2 (`aplicarSaldo`), leídos de sus
 * filas de auditoría FacturaProveedor/UPDATE_ESTADO: `entidadId` = factura y
 * `despues.origen` = { tipo: "PAGO", pagoId }. Un enlace que no sale aquí es
 * HEREDADO: su `monto` lo puso la migración (M3) o el re-avance, no una
 * persona. Pura; ignora filas que no son de un pago.
 */
export function enlacesAplicadosEnV2(
  filas: readonly { entidadId: string; despues: unknown }[],
): Set<string> {
  const enlaces = new Set<string>();
  for (const f of filas) {
    const d = f.despues;
    if (typeof d !== "object" || d === null || Array.isArray(d)) continue;
    const origen = (d as Record<string, unknown>).origen;
    if (typeof origen !== "object" || origen === null || Array.isArray(origen)) continue;
    const o = origen as Record<string, unknown>;
    if (o.tipo === "PAGO" && typeof o.pagoId === "string") enlaces.add(llaveEnlace(o.pagoId, f.entidadId));
  }
  return enlaces;
}

/**
 * ¿Los montos por enlace del pago son una ESTIMACIÓN de la migración y no un
 * dato? Sí si el pago es mixto (`esPagoMixto`) y alguno de sus enlaces es
 * heredado (no está en `aplicadosEnV2`). La migración reparte el valor del pago
 * por su cuenta (asesoría primero); en un pago mixto ese reparto decide cuánto
 * se le cobra al cliente, así que no se da por exacto: se usa la heurística de
 * Ascinter y el pago queda por revisar si no cuadra (ABONO_PARCIAL,
 * BLOQUE_SIN_MONTOS…). En un pago no mixto los montos no cambian lo cobrable
 * (todo o nada), así que no hace falta mirarlos.
 */
export function montosSonEstimados(
  pago: Pick<PagoDelLibro, "id" | "facturas">,
  aplicadosEnV2: ReadonlySet<string>,
): boolean {
  return esPagoMixto(pago) && pago.facturas.some((f) => !aplicadosEnV2.has(llaveEnlace(pago.id, f.facturaId)));
}

/** ¿Mandan los montos por enlace de CxP v2? Los trae y no son estimados. */
function montosMandan(pago: Pick<PagoDelLibro, "facturas" | "montosEstimados">): boolean {
  return !pago.montosEstimados && tieneMontosPorEnlace(pago);
}

/**
 * ¿Hay que buscar en la auditoría lo que el bloque le abonó a cada factura?
 * Solo un pago en bloque con asesoría cuyos montos v2 no mandan (enlace
 * heredado sin monto, o mixto con montos estimados por la migración).
 */
export function necesitaMontosDeAuditoria(
  pago: Pick<PagoDelLibro, "grupoPagoId" | "facturas" | "montosEstimados">,
): boolean {
  return esBloqueConAsesoria(pago) && !montosMandan(pago);
}

/**
 * Entrada de `desglosarPago` para cada pago del libro (1 a 1 y en el mismo
 * orden). Pura y determinista.
 *
 * - Pago con montos por enlace de CxP v2 (`tieneMontosPorEnlace`) que no
 *   son una estimación de la migración (`montosEstimados`) → cada enlace
 *   lleva su PagoTramiteFactura.monto, SIEMPRE (aunque la auditoría diga otra
 *   cosa, p. ej. un bloque editado después): exacto y nunca `bloqueSinMontos`.
 * - Pago mixto con montos ESTIMADOS por la migración → como un pago sin
 *   montos (las reglas de abajo): la asesoría pesa su factura y, si el pago no
 *   cuadra, queda por revisar (ABONO_PARCIAL, BLOQUE_SIN_MONTOS…).
 * - Pago en bloque heredado (sin montos v2) con montos inequívocos en la auditoría
 *   (`montosDeBloquesAuditados`) → cada enlace lleva su `monto`: exacto.
 * - Pago en bloque CON asesoría y SIN montos (auditoría ambigua) → cada
 *   factura NO SE COBRA pesa lo MAYOR entre su valor y el mayor monto que la
 *   auditoría le registra a esa factura en cualquier bloque, y el pago sale
 *   con `bloqueSinMontos` (por revisar). Así una asesoría pagada DE MÁS
 *   (factura 300.000 pagada en 357.000) nunca pasa al cliente aunque el pago
 *   cuadre con la suma de las facturas; el error posible va contra Galcomex.
 *   Las facturas que se cobran conservan su valor (subirlas cobraría de más).
 * - Cualquier otro pago → valor de las facturas, como siempre (los pagos
 *   sueltos y los 100 % repercutibles no cambian: casos dorados intactos).
 */
export function prepararPagosParaCobro(
  pagos: readonly PagoDelLibro[],
  abonos: readonly AbonoBloqueAuditado[],
): PagoPreparado[] {
  const montos = montosDeBloquesAuditados(
    pagos.map((p) => ({
      id: p.id,
      valor: p.valor,
      grupoPagoId: p.grupoPagoId,
      facturaIds: p.facturas.map((f) => f.facturaId),
    })),
    abonos,
  );

  const mayorAbonoPorFactura = new Map<string, bigint>();
  for (const a of abonos) {
    mayorAbonoPorFactura.set(a.facturaId, maximo(mayorAbonoPorFactura.get(a.facturaId) ?? 0n, a.monto));
  }

  return pagos.map((p) => {
    if (montosMandan(p)) {
      return {
        paraCobro: {
          valor: p.valor,
          costoBancario: p.costoBancario,
          facturas: p.facturas.map((f) => ({
            valorFactura: f.valorFactura,
            repercutible: f.repercutible,
            monto: f.monto ?? 0n,
          })),
        },
        bloqueSinMontos: false,
      };
    }
    const montosDelPago = montos.get(p.id);
    const bloqueSinMontos = montosDelPago === undefined && esBloqueConAsesoria(p);
    const facturas: EnlaceFacturaCobro[] = p.facturas.map((f) => {
      if (montosDelPago) {
        return {
          valorFactura: f.valorFactura,
          repercutible: f.repercutible,
          monto: montosDelPago.get(f.facturaId) ?? null,
        };
      }
      if (bloqueSinMontos && !f.repercutible) {
        return {
          valorFactura: maximo(f.valorFactura, mayorAbonoPorFactura.get(f.facturaId) ?? 0n),
          repercutible: false,
        };
      }
      return { valorFactura: f.valorFactura, repercutible: f.repercutible };
    });
    return {
      paraCobro: { valor: p.valor, costoBancario: p.costoBancario, facturas },
      bloqueSinMontos,
    };
  });
}

// ─── Pagos que, juntos, le cobran de más al cliente por sus facturas ─────────

/** Un pago del libro visto por lo que se le cobra al cliente (`sobranteCobradoPorGrupo`). */
export interface PagoCobradoConFacturas {
  /**
   * Lo que del pago se le cobra al cliente: `desglosarPago(...).cobrable.valor`
   * de su entrada preparada (`prepararPagosParaCobro`, con los montos del
   * bloque si los hay). En un pago 100 % repercutible es su valor (R2).
   */
  cobrable: bigint;
  /** Facturas enlazadas (las NO SE COBRA no cuentan: no se le cobran al cliente). */
  facturas: readonly EnlaceDelLibro[];
}

/**
 * Para cada pago (1 a 1 y en el mismo orden): ¿lo que se le cobra al cliente
 * por sus facturas que SÍ se cobran forma parte de un grupo de pagos que,
 * sumados, cobran más de lo que valen esas facturas? Pura y determinista.
 * Solo marca: no cambia lo cobrable.
 *
 * De cada pago cuenta solo su parte cobrable, contra sus facturas que se cobran:
 * - pago 100 % repercutible → su valor completo (R2) y todas sus facturas;
 * - pago mixto (transporte + asesoría) → su `cobrable` y solo sus facturas
 *   que se cobran (la asesoría ya se descontó en su reparto);
 * - pagos sueltos (ya van como PAGO_SIN_FACTURAS), de solo asesoría o sin
 *   nada cobrable (p. ej. valor 0) → no entran.
 *
 * Cierra el hueco de mirar los pagos de uno en uno: en un trámite con
 * asesoría, un transporte de 1.000.000 pagado con dos transferencias de
 * 650.000 enlazadas solo al transporte no dispara la marca individual
 * (650.000 < 1.000.000), pero entre las dos se le cobran 1.300.000 al cliente:
 * los 300.000 de más pueden ser asesoría sin enlazar. Lo mismo si un bloque
 * ya pagó el transporte completo junto con la asesoría (1.300.000, de los que
 * se cobran 1.000.000) y otra transferencia de 650.000 se enlaza solo al
 * transporte: al cliente se le cobran 1.650.000 por una factura de 1.000.000.
 *
 * Grupo = los pagos cuyas facturas que se cobran caben todas en un mismo
 * conjunto de facturas F, comparado con Σ valor de las facturas de F. Se
 * prueban como F:
 * - las facturas que se cobran de cada pago (incluye a los pagos enlazados
 *   exactamente a las mismas facturas y a los que enlazan solo una parte de
 *   ellas), y
 * - las de cada cadena de pagos que comparten facturas (p. ej. uno a
 *   {T1, T2} y otro a {T2, T3} → F = {T1, T2, T3}).
 * Si Σ cobrable de los pagos del grupo > Σ valor de las facturas de F, se
 * marcan TODOS los pagos del grupo: por esas facturas se le cobra al cliente
 * más de lo que valen, así que parte de lo cobrado no sale de ellas. Una
 * factura con valor ≤ 0 (imposible: zod exige > 0) cuenta como 0.
 */
export function sobranteCobradoPorGrupo(pagos: readonly PagoCobradoConFacturas[]): boolean[] {
  const valorFactura = new Map<string, bigint>();
  const candidatos: Array<{ indice: number; facturas: Set<string> }> = [];
  pagos.forEach((p, indice) => {
    const queSeCobran = p.facturas.filter((f) => f.repercutible);
    if (p.cobrable <= 0n || queSeCobran.length === 0) return;
    for (const f of queSeCobran) valorFactura.set(f.facturaId, maximo(f.valorFactura, 0n));
    candidatos.push({ indice, facturas: new Set(queSeCobran.map((f) => f.facturaId)) });
  });

  // Cadenas de pagos que comparten facturas: se unen hasta que no cambie nada.
  const cadenas: Set<string>[] = [];
  for (const c of candidatos) {
    let union = new Set(c.facturas);
    for (let i = cadenas.length - 1; i >= 0; i--) {
      if ([...cadenas[i]].some((id) => union.has(id))) {
        union = new Set([...union, ...cadenas[i]]);
        cadenas.splice(i, 1);
      }
    }
    cadenas.push(union);
  }

  const marcados = pagos.map(() => false);
  for (const conjunto of [...candidatos.map((c) => c.facturas), ...cadenas]) {
    const grupo = candidatos.filter((c) => [...c.facturas].every((id) => conjunto.has(id)));
    const cobrado = suma(grupo.map((c) => pagos[c.indice].cobrable));
    const facturado = suma([...conjunto].map((id) => valorFactura.get(id) ?? 0n));
    if (cobrado > facturado) {
      for (const c of grupo) marcados[c.indice] = true;
    }
  }
  return marcados;
}

// ─── ¿Queda asesoría sin cubrir por los pagos enlazados? ─────────────────────

/** Una factura NO SE COBRA del trámite, enlazada o no a pagos del libro. */
export interface AsesoriaDelTramite {
  facturaId: string;
  /** FacturaProveedor.valor (COP). */
  valor: bigint;
  /**
   * Pasó a PAGADA por cruce de saldos, sin pago del libro
   * (FacturaProveedor.compensacionId no nulo): ningún pago la paga.
   */
  compensada: boolean;
  /**
   * CxP v2: parte del valor saldada por cruce (FacturaProveedor.montoCompensado;
   * un cruce puede ser parcial). Si viene, solo esa parte se da por cubierta
   * aunque `compensada` sea true; si no viene, `compensada` la cubre toda.
   */
  montoCompensado?: bigint;
}

/** Un pago del libro con lo que, según su reparto, no se le cobra al cliente. */
export interface PagoConParteNoCobrable {
  /** Id de cada factura enlazada, en el MISMO orden que `paraCobro.facturas`. */
  facturaIds: readonly string[];
  /** Entrada de `desglosarPago` (con los montos del bloque si los hay). */
  paraCobro: PagoParaCobro;
  /** `desglosarPago(paraCobro).noCobrable`. */
  noCobrable: bigint;
}

function compararIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Ids (en el orden de entrada) de las facturas NO SE COBRA del trámite que no
 * se saldaron por cruce de saldos y cuyo valor no alcanza a cubrir la parte no
 * cobrable de los pagos enlazados a ellas. Pura y determinista.
 *
 * Evita marcar en falso los pagos sueltos (PAGO_SIN_FACTURAS): si toda la
 * asesoría del trámite ya la pagaron pagos enlazados a su factura (o se
 * compensó), un pago suelto no puede ser asesoría sin enlazar.
 *
 * Lo no cobrable de cada pago se reparte entre sus facturas NO SE COBRA aún
 * sin cubrir: a cada una, como mucho lo que le falta y lo que el pago le abona
 * (su peso: el monto por enlace si se conoce, si no el valor de su factura;
 * ver `pesosDeEnlaces`). Lo que sobra (p. ej. un sobrante que asume Galcomex)
 * no cubre otra asesoría. Van primero los pagos enlazados a una sola asesoría
 * (no hay nada que elegir) y luego los demás; en cada grupo, en el orden del
 * libro, y las facturas de un mismo pago por id. Con varias asesorías en un
 * mismo pago el reparto es una aproximación: si deja alguna sin cubrir, lo
 * peor que pasa es que un pago suelto se marca de más (nunca cambia un total).
 */
export function asesoriasSinCubrir(
  asesorias: readonly AsesoriaDelTramite[],
  pagos: readonly PagoConParteNoCobrable[],
): string[] {
  const falta = new Map<string, bigint>();
  for (const a of asesorias) {
    const cruzado =
      a.montoCompensado !== undefined ? maximo(a.montoCompensado, 0n) : a.compensada ? a.valor : 0n;
    const pendiente = a.valor - cruzado;
    if (pendiente > 0n) falta.set(a.facturaId, pendiente);
  }

  const repartos = pagos.flatMap((p) => {
    if (p.noCobrable <= 0n) return [];
    const pesos = pesosDeEnlaces(p.paraCobro.facturas);
    const enlaces = p.paraCobro.facturas
      .map((f, i) => ({ facturaId: p.facturaIds[i], repercutible: f.repercutible, peso: pesos[i] }))
      .filter((e) => !e.repercutible && falta.has(e.facturaId))
      .sort((a, b) => compararIds(a.facturaId, b.facturaId));
    return enlaces.length === 0 ? [] : [{ noCobrable: p.noCobrable, enlaces }];
  });
  // `sort` es estable: dentro de cada grupo se conserva el orden del libro.
  repartos.sort((a, b) => Number(a.enlaces.length > 1) - Number(b.enlaces.length > 1));

  for (const { noCobrable, enlaces } of repartos) {
    let restante = noCobrable;
    for (const { facturaId, peso } of enlaces) {
      const pendiente = falta.get(facturaId) ?? 0n;
      const abono = minimo(minimo(restante, pendiente), peso ?? restante);
      falta.set(facturaId, pendiente - abono);
      restante -= abono;
    }
  }
  return asesorias.filter((a) => (falta.get(a.facturaId) ?? 0n) > 0n).map((a) => a.facturaId);
}

// ─── Por qué un pago queda por revisar ───────────────────────────────────────

/**
 * Motivo por el que un pago va a `pagosPorRevisar` del borrador:
 * - BLOQUE_SIN_MONTOS: pago en bloque con asesoría cuya auditoría no dice
 *   cuánto se abonó a cada factura; no se cobra la asesoría por lo mayor
 *   entre su factura y lo que la auditoría le registra
 *   (`prepararPagosParaCobro`) ni, si lo hay, el sobrante.
 * - SOBRANTE_NO_COBRADO: pago con asesoría mayor que sus facturas; el
 *   sobrante lo asume Galcomex (¿era transporte sin factura enlazada?).
 * - ABONO_PARCIAL: pago mixto menor que sus facturas; se descontó la
 *   asesoría por el valor de su factura. Si en este pago no se pagó
 *   completa, al cliente se le cobra de menos; si se le pagó más de lo que
 *   dice su factura (p. ej. con IVA), al cliente se le cobra de más.
 * - SOBRANTE_COBRADO: en un trámite con asesoría, lo que se le cobra al
 *   cliente de un pago por facturas que se cobran, solo o junto con otros
 *   pagos de esas mismas facturas, pasa de lo que valen
 *   (`sobranteCobradoPorGrupo`, también la parte cobrable de un pago mixto);
 *   el sobrante SÍ se le cobra al cliente (¿era asesoría sin enlazar?).
 * - PAGO_SIN_FACTURAS: pago sin facturas enlazadas en un trámite con
 *   asesoría que sus pagos enlazados no cubren (`asesoriasSinCubrir`); se le
 *   cobra completo al cliente (¿era asesoría sin enlazar?).
 */
export const MOTIVOS_REVISION_PAGO = [
  "BLOQUE_SIN_MONTOS",
  "SOBRANTE_NO_COBRADO",
  "ABONO_PARCIAL",
  "SOBRANTE_COBRADO",
  "PAGO_SIN_FACTURAS",
] as const;

export type MotivoRevisionPago = (typeof MOTIVOS_REVISION_PAGO)[number];

/** Contexto del pago dentro del trámite para decidir si se revisa. */
export interface ContextoRevisionPago {
  /** El pago es un bloque con asesoría sin montos de la auditoría (`PagoPreparado`). */
  bloqueSinMontos: boolean;
  /**
   * El trámite tiene al menos una factura de proveedor NO SE COBRA (enlazada
   * o no, cubierta o no). Habilita SOBRANTE_COBRADO.
   */
  tramiteConAsesoria: boolean;
  /**
   * Alguna factura NO SE COBRA del trámite ni está cubierta por lo no
   * cobrable de sus pagos enlazados ni se compensó (`asesoriasSinCubrir`).
   * Habilita PAGO_SIN_FACTURAS. Implica `tramiteConAsesoria`.
   */
  asesoriaSinCubrir: boolean;
  /**
   * La parte cobrable del pago está en un grupo de pagos que, sumados, le
   * cobran al cliente más de lo que valen sus facturas que se cobran
   * (`sobranteCobradoPorGrupo`).
   */
  sobranteCobradoEnGrupo: boolean;
}

/**
 * Motivo por el que el pago queda por revisar, o `null` si su reparto es
 * seguro. Solo marca: no cambia lo cobrable (ningún total cambia). Combina
 * `desglose.porRevisar` con las marcas del trámite, en este orden:
 * 1. bloque sin montos; 2. `desglose.porRevisar` (sobrante o abono parcial);
 * 3. un pago que no le cobra nada al cliente (valor 0 o solo asesoría) no se
 *    revisa;
 * 4. pago suelto: solo si queda asesoría sin cubrir (`asesoriaSinCubrir`);
 * 5. solo en un trámite con asesoría: pago de solo facturas que se cobran con
 *    valor mayor que la suma de sus facturas, o pago (también mixto) cuya
 *    parte cobrable, sola o con otros pagos de esas facturas, les cobra de
 *    más (`sobranteCobradoEnGrupo`).
 */
export function motivoRevisionPago(
  pago: PagoParaCobro,
  desglose: DesglosePago,
  contexto: ContextoRevisionPago,
): MotivoRevisionPago | null {
  if (contexto.bloqueSinMontos) return "BLOQUE_SIN_MONTOS";
  if (desglose.porRevisar) {
    return pago.valor > desglose.sumaFacturas ? "SOBRANTE_NO_COBRADO" : "ABONO_PARCIAL";
  }
  if (desglose.cobrable.valor <= 0n) return null;
  if (pago.facturas.length === 0) return contexto.asesoriaSinCubrir ? "PAGO_SIN_FACTURAS" : null;
  if (!contexto.tramiteConAsesoria) return null;
  const pagaDeMasSolo =
    pago.facturas.every((f) => f.repercutible) && pago.valor > desglose.sumaFacturas;
  return pagaDeMasSolo || contexto.sobranteCobradoEnGrupo ? "SOBRANTE_COBRADO" : null;
}
