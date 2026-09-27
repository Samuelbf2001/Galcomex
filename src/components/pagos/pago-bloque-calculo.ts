/**
 * Cálculo PURO del modal "Pagar en bloque" (diseño CxP v2 §D.2, paquete P4).
 * Sin BD, sin React — BigInt, tolerancia 0. Reutiliza el núcleo de `saldos.ts`
 * (P0) para el costo bancario, el formato de dinero y `doCorto`.
 *
 * Las facturas que recibe cada función son las que devuelve
 * `GET /api/pagos/multi?beneficiarioId=` con el contrato `FacturaElegibleJson`
 * (`@/lib/cxp/contratos-api`, P0): ya vienen con `pagable`, `motivoNoPagable`,
 * `advertencias` y `puedeAbsorberCosto` calculados por el servidor — esta capa
 * solo agrega/valida la SELECCIÓN que hace la persona en pantalla.
 */

import { unirLista } from "@/lib/cxp/errores";
import { costoPorPago, formatoPesos, reglaCostoPorDefecto } from "@/lib/cxp/saldos";

import type { FacturaElegibleJson } from "@/lib/cxp/contratos-api";
import type { CostoAsumidoPor } from "@/lib/cxp/tipos";

// ─── Selección (facturaId → monto en dígitos) ────────────────────────────────

/** facturaId → monto a pagar (string de dígitos, formato `CampoMoneda`). Ausencia = no seleccionada. */
export type SeleccionBloque = Record<string, string>;

function montoSeleccionado(raw: string | undefined): bigint {
  if (raw === undefined || raw === "") return 0n;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : 0n;
  } catch {
    return 0n;
  }
}

/** Ids de facturas con un monto > 0 en la selección (ignora entradas en "" o inválidas). */
function idsSeleccionadas(sel: SeleccionBloque): Set<string> {
  const ids = new Set<string>();
  for (const [id, raw] of Object.entries(sel)) {
    if (montoSeleccionado(raw) > 0n) ids.add(id);
  }
  return ids;
}

/**
 * Preselección al abrir el modal (arregla paso 4 del "paso a paso"): todas
 * las facturas PAGABLES marcadas con monto = saldo. Excepción RF-23: si la
 * ficha del proveedor tiene `conciliacionPendiente`, se abre SIN nada
 * marcado (la persona debe revisar su Excel antes de marcar).
 */
export function seleccionInicial(
  facturas: readonly FacturaElegibleJson[],
  conciliacionPendiente: boolean,
): SeleccionBloque {
  if (conciliacionPendiente) return {};
  return marcarTodas(facturas);
}

/** "Marcar todas": todas las pagables a su saldo completo; las no pagables se ignoran. */
export function marcarTodas(facturas: readonly FacturaElegibleJson[]): SeleccionBloque {
  const sel: SeleccionBloque = {};
  for (const f of facturas) {
    if (f.pagable) sel[f.id] = f.saldo;
  }
  return sel;
}

/** "Desmarcar todas". */
export function desmarcarTodas(): SeleccionBloque {
  return {};
}

// ─── Validación del monto de una fila ────────────────────────────────────────

export type ValidacionMonto = { ok: true; monto: bigint } | { ok: false; mensaje: string };

/**
 * Valida el monto escrito para UNA factura: entero > 0 y ≤ saldo (abono
 * permitido, nunca más del saldo). `raw` son dígitos (lo que entrega
 * `CampoMoneda`), nunca el texto formateado.
 */
export function validarMonto(raw: string, saldo: bigint): ValidacionMonto {
  const limpio = raw.trim();
  if (limpio === "" || limpio === "-") {
    return { ok: false, mensaje: "Escribe el monto a pagar." };
  }
  let monto: bigint;
  try {
    monto = BigInt(limpio);
  } catch {
    return { ok: false, mensaje: "El monto debe ser un número entero." };
  }
  if (monto <= 0n) {
    return { ok: false, mensaje: "El monto debe ser mayor que cero." };
  }
  if (monto > saldo) {
    return { ok: false, mensaje: `No puedes pagar más de lo que falta (${formatoPesos(saldo)}).` };
  }
  return { ok: true, monto };
}

// ─── Totales de la selección ──────────────────────────────────────────────────

export interface AbonoSeleccion {
  facturaId: string;
  numFactura: string;
  /** Saldo que le queda a la factura después de este pago (> 0 = queda Abonada). */
  faltante: bigint;
}

export interface TotalesSeleccion {
  totalSeleccionado: bigint;
  nFacturas: number;
  /** DOs distintos entre las facturas seleccionadas. */
  nDOs: number;
  /** Facturas seleccionadas cuyo monto es menor que su saldo (quedan "Abonada"). */
  abonos: AbonoSeleccion[];
}

/** "Total a pagar: $1.358.815 · 3 facturas · 3 DOs" + qué facturas quedan abonadas. */
export function totalesSeleccion(facturas: readonly FacturaElegibleJson[], sel: SeleccionBloque): TotalesSeleccion {
  const porId = new Map(facturas.map((f) => [f.id, f] as const));
  const dosIds = new Set<string>();
  const abonos: AbonoSeleccion[] = [];
  let total = 0n;
  let nFacturas = 0;

  for (const [facturaId, raw] of Object.entries(sel)) {
    const monto = montoSeleccionado(raw);
    if (monto <= 0n) continue;
    const f = porId.get(facturaId);
    if (!f) continue;
    total += monto;
    nFacturas += 1;
    dosIds.add(f.tramiteId);
    const saldo = BigInt(f.saldo);
    if (monto < saldo) {
      abonos.push({ facturaId, numFactura: f.numFacturaVisible, faltante: saldo - monto });
    }
  }

  return { totalSeleccionado: total, nFacturas, nDOs: dosIds.size, abonos };
}

// ─── Advertencias de la selección (no bloquean) ──────────────────────────────

export interface AdvertenciaTexto {
  codigo: string;
  mensaje: string;
}

/**
 * Advertencias (`FacturaElegibleJson.advertencias`, ya calculadas por el
 * servidor: "El DO … queda en −$…", "anticipo aún no verificado…") de las
 * facturas seleccionadas, sin repetir la misma advertencia dos veces para el
 * mismo DO.
 */
export function advertenciasSeleccion(
  facturas: readonly FacturaElegibleJson[],
  sel: SeleccionBloque,
): AdvertenciaTexto[] {
  const seleccionadas = idsSeleccionadas(sel);
  const vistas = new Set<string>();
  const resultado: AdvertenciaTexto[] = [];
  for (const f of facturas) {
    if (!seleccionadas.has(f.id)) continue;
    for (const a of f.advertencias) {
      const clave = `${a.codigo}:${f.tramiteId}`;
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      resultado.push({ codigo: a.codigo, mensaje: a.mensaje });
    }
  }
  return resultado;
}

// ─── Opciones de "¿quién asume el costo?" (D-1, R8) ──────────────────────────

export interface OpcionCosto {
  value: CostoAsumidoPor;
  label: string;
}

export interface OpcionesCosto {
  opciones: OpcionCosto[];
  defecto: CostoAsumidoPor;
  /** DO (doCorto) al que iría el costo con PRIMER_DO; null si ninguno puede absorberlo. */
  primerDoCorto: string | null;
  /** Nota cuando solo queda "Galcomex" en las opciones. */
  notaSoloGalcomex: string | null;
}

/**
 * DOs de la selección (uno por `tramiteId`, ordenados por `doCorto` = orden
 * por consecutivo) con su `puedeAbsorberCosto` (D-1, ya lo trae el JSON). Como
 * en el servidor (`puedeAbsorberCostoDelBloque`), un DO cuyas facturas
 * elegidas son TODAS asesoría (NO SE COBRA) no puede absorberlo: el costo va
 * al primer DO con algo que se le cobra al cliente. `valor` = lo que el tramo
 * le cobra al cliente (solo facturas que se cobran): es el peso del prorrateo,
 * así la asesoría no atrae costo bancario.
 */
function dosDeLaSeleccion(
  facturas: readonly FacturaElegibleJson[],
  sel: SeleccionBloque,
): { tramiteId: string; doCorto: string; puedeAbsorber: boolean; valor: bigint }[] {
  const seleccionadas = idsSeleccionadas(sel);
  const porDo = new Map<string, { tramiteId: string; doCorto: string; puedeAbsorber: boolean; valor: bigint }>();
  const conAlgoCobrable = new Set<string>();
  for (const f of facturas) {
    if (!seleccionadas.has(f.id)) continue;
    const monto = f.repercutible ? montoSeleccionado(sel[f.id]) : 0n;
    if (f.repercutible) conAlgoCobrable.add(f.tramiteId);
    const existente = porDo.get(f.tramiteId);
    if (existente) {
      existente.valor += monto;
      // Si CUALQUIER factura del DO en la selección no puede absorber, el DO no puede.
      existente.puedeAbsorber = existente.puedeAbsorber && f.puedeAbsorberCosto;
    } else {
      porDo.set(f.tramiteId, {
        tramiteId: f.tramiteId,
        doCorto: f.doCorto,
        puedeAbsorber: f.puedeAbsorberCosto,
        valor: monto,
      });
    }
  }
  return [...porDo.values()]
    .map((d) => ({ ...d, puedeAbsorber: d.puedeAbsorber && conAlgoCobrable.has(d.tramiteId) }))
    .sort((a, b) => (a.doCorto < b.doCorto ? -1 : a.doCorto > b.doCorto ? 1 : 0));
}

/**
 * Opciones del selector "¿Quién asume el costo de la transferencia?" (§D.2):
 * si ningún DO de la selección puede absorberlo, solo aparece "Galcomex" con
 * la nota; si alguno puede, aparecen las tres opciones y el defecto lo calcula
 * `reglaCostoPorDefecto` (P0).
 */
export function opcionesCosto(facturas: readonly FacturaElegibleJson[], sel: SeleccionBloque): OpcionesCosto {
  const dos = dosDeLaSeleccion(facturas, sel);
  const puedenAbsorber = dos.filter((d) => d.puedeAbsorber);

  if (puedenAbsorber.length === 0) {
    return {
      opciones: [{ value: "GALCOMEX", label: "Galcomex (no se cobra a nadie)" }],
      defecto: "GALCOMEX",
      primerDoCorto: null,
      notaSoloGalcomex:
        "Los DOs escogidos ya están facturados o su cliente no factura costos bancarios: lo asume Galcomex.",
    };
  }

  const primero = puedenAbsorber[0];
  return {
    opciones: [
      { value: "PRIMER_DO", label: `Al primer DO que aún se puede cobrar (${primero.doCorto})` },
      { value: "PRORRATEADO", label: "Repartido entre los DOs que aún se pueden cobrar" },
      { value: "GALCOMEX", label: "Galcomex (no se cobra a nadie)" },
    ],
    defecto: reglaCostoPorDefecto(dos.map((d) => ({ puedeAbsorber: d.puedeAbsorber }))),
    primerDoCorto: primero.doCorto,
    notaSoloGalcomex: null,
  };
}

/**
 * Costo bancario por DO de la selección (mismo orden que `dosDeLaSeleccion`),
 * para mostrar "Costo de la transferencia $X" en cada fila si se necesitara
 * el detalle por DO. Reexporta `costoPorPago` (P0) ya resuelto con los DOs de
 * ESTA selección.
 */
export function costoPorDoDeLaSeleccion(
  facturas: readonly FacturaElegibleJson[],
  sel: SeleccionBloque,
  regla: CostoAsumidoPor,
  costoBancario: bigint,
): { tramiteId: string; doCorto: string; costo: bigint }[] {
  const dos = dosDeLaSeleccion(facturas, sel);
  const montos = costoPorPago(
    regla,
    costoBancario,
    dos.map((d) => ({ valor: d.valor, puedeAbsorber: d.puedeAbsorber })),
  );
  return dos.map((d, i) => ({ tramiteId: d.tramiteId, doCorto: d.doCorto, costo: montos[i] ?? 0n }));
}

// ─── Texto de confirmación (CA-05) ────────────────────────────────────────────

function pluralizar(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "Costo de la transferencia: $3.900 (lo asume Galcomex)." null si no hay costo. */
export function textoCostoBancario(
  costoBancario: bigint,
  costoAsumidoPor: CostoAsumidoPor,
  primerDoCorto: string | null,
): string | null {
  if (costoBancario <= 0n) return null;
  const quien =
    costoAsumidoPor === "GALCOMEX"
      ? "lo asume Galcomex"
      : costoAsumidoPor === "PRIMER_DO"
        ? `lo asume el DO ${primerDoCorto ?? ""}`.trim()
        : "se reparte entre los DOs que pueden absorberlo";
  return `Costo de la transferencia: ${formatoPesos(costoBancario)} (${quien}).`;
}

export interface TextoConfirmacionInput {
  nombreProveedor: string;
  totales: TotalesSeleccion;
  costoBancario: bigint;
  costoAsumidoPor: CostoAsumidoPor;
  primerDoCorto: string | null;
  /** RF-23: agrega la pregunta de conciliación al final. */
  conciliacionPendiente: boolean;
}

/**
 * "Vas a pagar 3 facturas de 3 DOs por $1.358.815 a ALMACARGA. 1 queda
 * abonada: faltan $200.000. Costo de la transferencia: $3.900 (lo asume
 * Galcomex). ¿Confirmas?" (§D.2, CA-05).
 */
export function textoConfirmacion(i: TextoConfirmacionInput): string {
  const { totales } = i;
  const partes: string[] = [
    `Vas a pagar ${pluralizar(totales.nFacturas, "factura", "facturas")} de ${pluralizar(totales.nDOs, "DO", "DOs")} por ${formatoPesos(totales.totalSeleccionado)} a ${i.nombreProveedor}.`,
  ];

  if (totales.abonos.length > 0) {
    const n = totales.abonos.length;
    const verbo = n === 1 ? "queda" : "quedan";
    const sufijo = n === 1 ? "" : "s";
    const montos = unirLista(totales.abonos.map((a) => formatoPesos(a.faltante)));
    partes.push(`${n} ${verbo} abonada${sufijo}: faltan ${montos}.`);
  }

  const costoTexto = textoCostoBancario(i.costoBancario, i.costoAsumidoPor, i.primerDoCorto);
  if (costoTexto) partes.push(costoTexto);

  if (i.conciliacionPendiente) {
    partes.push(
      `La cartera de ${i.nombreProveedor} aún no está conciliada. ¿Revisaste en tu Excel que ninguna de estas facturas ya se pagó?`,
    );
  }

  partes.push("¿Confirmas?");
  return partes.join(" ");
}

/** "Ya pagado" de una fila: total − saldo (lo aplicado, los ajustes y lo cruzado). */
export function yaPagado(f: { valor: string; saldo: string }): string {
  try {
    const v = BigInt(f.valor) - BigInt(f.saldo);
    return (v > 0n ? v : 0n).toString();
  } catch {
    return "0";
  }
}

/** Si el monto escrito es un abono (menor que el saldo), cuánto quedará debiendo; si no, null. */
export function faltanteAbono(montoRaw: string, saldo: string): bigint | null {
  try {
    if (montoRaw.trim() === "") return null;
    const monto = BigInt(montoRaw);
    const s = BigInt(saldo);
    return monto > 0n && monto < s ? s - monto : null;
  } catch {
    return null;
  }
}
