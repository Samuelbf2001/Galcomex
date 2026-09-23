/**
 * Motor de tarifas — Galcomex (M2)
 *
 * Función PURA, sin BD: recibe los ítems del tarifario vigente de la empresa
 * y el contexto del trámite (base de cálculo + eventos marcados + costos que
 * se espejan) y devuelve las líneas propuestas para la factura de venta.
 *
 * Reglas (todas vienen de la propuesta comercial, ninguna vive en código):
 *
 *   FIJO                   valor                             (gastos de trámite por embarque)
 *   POR_UNIDAD             valor × cantidad(unidad)          (10.000 por declaración)
 *   PORCENTAJE_MIN         CIF × bps / 10.000, con mínimo    (CW: 0,37 % · mín. 498.000 en 20′)
 *                          por tipo de carga
 *   PRIMERO_MAS_ADICIONAL  valor + valorAdicional × (n − 1)  (clasificación: 380.000 + 180.000/ítem)
 *   ESPEJO_DE_COSTO        lo que costó, tal cual            (pago del registro VUCE)
 *   POR_TRAMO              precio unitario según el total    (Polyrec ZF: 1 contenedor 300.000;
 *                          de unidades, × todas               2 o más, 250.000 cada uno)
 *
 * Disparador:
 *   SIEMPRE  → en todo trámite.
 *   EVENTO   → solo si el trámite tiene marcado `eventoCodigo` (cantidad del evento).
 *   MANUAL   → no se genera; se devuelve en `manuales` para que el revisor lo agregue.
 *
 * Si falta un dato de la base de cálculo (CIF, número de contenedores…) el ítem
 * NO se inventa con cero: se devuelve en `pendientes` con el motivo, para que
 * la UI lo pida antes de facturar. Tolerancia cero: todo es BigInt en COP.
 */

export type TipoCalculoTarifa =
  | "FIJO"
  | "POR_UNIDAD"
  | "PORCENTAJE_MIN"
  | "PRIMERO_MAS_ADICIONAL"
  | "ESPEJO_DE_COSTO"
  | "POR_TRAMO";

export type DisparadorTarifa = "SIEMPRE" | "EVENTO" | "MANUAL";

export type UnidadTarifa =
  | "TRAMITE"
  | "CONTENEDOR"
  | "DECLARACION"
  | "DOCUMENTO"
  | "ITEM"
  | "MES";

export type TipoCarga = "SUELTA" | "CONTENEDOR_20" | "CONTENEDOR_40";

/** Mínimos de un ítem PORCENTAJE_MIN, en COP string (JSON en BD). */
export type MinimosTarifa = Partial<Record<TipoCarga, string>>;

/**
 * Tramo de un ítem POR_TRAMO: hasta `hasta` unidades (inclusive) el precio
 * unitario es `valor`; `hasta = null` es "en adelante". COP string (JSON en BD).
 */
export type TramoTarifa = { hasta: number | null; valor: string };

export interface ItemTarifaCalculable {
  concepto: string;
  nombrePublico: string;
  siigoCodigo: string | null;
  tipoCalculo: TipoCalculoTarifa;
  disparador: DisparadorTarifa;
  eventoCodigo: string | null;
  unidad: UnidadTarifa;
  valor: bigint;
  valorAdicional: bigint | null;
  porcentajeBps: number | null;
  minimos: MinimosTarifa | null;
  conceptoCosto: string | null;
  tramos: TramoTarifa[] | null;
  aplicaIva: boolean;
  orden: number;
}

export interface EventoMarcado {
  codigo: string;
  cantidad: number;
}

export interface ContextoTarifa {
  valorCif: bigint | null;
  tipoCarga: TipoCarga | null;
  numContenedores: number | null;
  numDeclaraciones: number | null;
  numDocumentos: number | null;
  numItems: number | null;
  eventos: EventoMarcado[];
  /** Costos reales del trámite que un ítem ESPEJO_DE_COSTO puede reflejar. */
  costos: CostoEspejable[];
}

export interface CostoEspejable {
  concepto: string;
  valor: bigint;
}

export interface LineaPropuesta {
  concepto: string;
  nombrePublico: string;
  siigoCodigo: string | null;
  cantidad: number;
  valorUnitario: bigint;
  valor: bigint;
  aplicaIva: boolean;
  origen: "SIEMPRE" | "EVENTO";
  /** Cómo se llegó al valor, para mostrarlo al revisor. */
  detalle: string;
}

export interface ItemPendiente {
  concepto: string;
  nombrePublico: string;
  motivo: string;
}

export interface ResultadoTarifa {
  lineas: LineaPropuesta[];
  pendientes: ItemPendiente[];
  /** Ítems MANUAL del tarifario, disponibles para agregar a mano. */
  manuales: ItemTarifaCalculable[];
  total: bigint;
  totalConIva: bigint;
}

const ETIQUETA_CARGA: Record<TipoCarga, string> = {
  SUELTA: "carga suelta",
  CONTENEDOR_20: "contenedor de 20′",
  CONTENEDOR_40: "contenedor de 40′ o HQ",
};

const ETIQUETA_UNIDAD: Record<UnidadTarifa, string> = {
  TRAMITE: "trámite",
  CONTENEDOR: "contenedor",
  DECLARACION: "declaración",
  DOCUMENTO: "documento",
  ITEM: "ítem",
  MES: "mes",
};

const PLURAL_UNIDAD: Record<UnidadTarifa, string> = {
  TRAMITE: "trámites",
  CONTENEDOR: "contenedores",
  DECLARACION: "declaraciones",
  DOCUMENTO: "documentos",
  ITEM: "ítems",
  MES: "meses",
};

function unidades(unidad: UnidadTarifa, cantidad: number): string {
  return cantidad === 1 ? ETIQUETA_UNIDAD[unidad] : PLURAL_UNIDAD[unidad];
}

function formatoCOP(valor: bigint): string {
  return valor.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Redondeo half-up de `cif × bps / 10.000` en enteros. */
export function porcentajeSobre(base: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  return (base * BigInt(bps) + 5_000n) / 10_000n;
}

/**
 * Cantidad que aplica a una unidad, según la base de cálculo del trámite.
 * `null` = el dato no está capturado (distinto de 0, que sí es un dato).
 */
function cantidadDeUnidad(unidad: UnidadTarifa, ctx: ContextoTarifa): number | null {
  switch (unidad) {
    case "TRAMITE":
    case "MES":
      return 1;
    case "CONTENEDOR":
      return ctx.numContenedores;
    case "DECLARACION":
      return ctx.numDeclaraciones;
    case "DOCUMENTO":
      return ctx.numDocumentos;
    case "ITEM":
      return ctx.numItems;
  }
}

function motivoFaltante(unidad: UnidadTarifa): string {
  switch (unidad) {
    case "CONTENEDOR":
      return "Falta el número de contenedores del trámite";
    case "DECLARACION":
      return "Falta el número de declaraciones del trámite";
    case "DOCUMENTO":
      return "Falta el número de documentos del trámite";
    case "ITEM":
      return "Falta el número de ítems del trámite";
    case "TRAMITE":
    case "MES":
      return "Sin cantidad";
  }
}

function minimoDe(minimos: MinimosTarifa | null, tipoCarga: TipoCarga): bigint | null {
  const raw = minimos?.[tipoCarga];
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Tramo que aplica a `n` unidades: el primero cuyo `hasta` la cubre, o el
 * abierto (`hasta = null`). Los tramos se ordenan aquí, así que el orden en
 * que se guardaron no importa. Sin tramo que cubra → null (dato incompleto).
 */
export function tramoPara(tramos: TramoTarifa[], n: number): TramoTarifa | null {
  const ordenados = [...tramos].sort((a, b) => {
    if (a.hasta === null) return 1;
    if (b.hasta === null) return -1;
    return a.hasta - b.hasta;
  });
  for (const tramo of ordenados) {
    if (tramo.hasta === null || n <= tramo.hasta) return tramo;
  }
  return null;
}

function valorTramo(tramo: TramoTarifa): bigint | null {
  try {
    return /^\d+$/.test(tramo.valor) ? BigInt(tramo.valor) : null;
  } catch {
    return null;
  }
}

function etiquetaTramo(tramo: TramoTarifa, tramos: TramoTarifa[], unidad: UnidadTarifa): string {
  if (tramo.hasta === null) {
    const previos = tramos.filter((t) => t.hasta !== null).map((t) => t.hasta as number);
    const desde = previos.length ? Math.max(...previos) + 1 : 1;
    return `${desde} o más ${PLURAL_UNIDAD[unidad]}`;
  }
  return tramo.hasta === 1 ? `1 ${ETIQUETA_UNIDAD[unidad]}` : `hasta ${tramo.hasta} ${PLURAL_UNIDAD[unidad]}`;
}

function buscarCosto(costos: CostoEspejable[], conceptoCosto: string): CostoEspejable | null {
  const clave = conceptoCosto.trim().toLowerCase();
  if (!clave) return null;
  return costos.find((c) => c.concepto.toLowerCase().includes(clave)) ?? null;
}

type Calculo =
  | { ok: true; cantidad: number; valorUnitario: bigint; valor: bigint; detalle: string }
  | { ok: false; motivo: string };

function calcularItem(item: ItemTarifaCalculable, ctx: ContextoTarifa, cantidadEvento: number | null): Calculo {
  switch (item.tipoCalculo) {
    case "FIJO": {
      const cantidad = cantidadEvento ?? 1;
      return {
        ok: true,
        cantidad,
        valorUnitario: item.valor,
        valor: item.valor * BigInt(cantidad),
        detalle: cantidad === 1 ? "Valor fijo" : `Valor fijo × ${cantidad}`,
      };
    }

    case "POR_UNIDAD": {
      const cantidad = cantidadEvento ?? cantidadDeUnidad(item.unidad, ctx);
      if (cantidad === null) return { ok: false, motivo: motivoFaltante(item.unidad) };
      return {
        ok: true,
        cantidad,
        valorUnitario: item.valor,
        valor: item.valor * BigInt(cantidad),
        detalle: `${formatoCOP(item.valor)} × ${cantidad} ${unidades(item.unidad, cantidad)}`,
      };
    }

    case "PORCENTAJE_MIN": {
      if (ctx.valorCif === null) return { ok: false, motivo: "Falta el valor CIF (valor en aduana) del trámite" };
      if (item.porcentajeBps === null) return { ok: false, motivo: "El ítem no tiene porcentaje configurado" };
      const calculado = porcentajeSobre(ctx.valorCif, item.porcentajeBps);
      const pct = (item.porcentajeBps / 100).toFixed(2).replace(".", ",");

      if (ctx.tipoCarga === null) {
        // Sin tipo de carga no se puede aplicar mínimo: si hay mínimos definidos, se pide el dato.
        if (item.minimos && Object.keys(item.minimos).length > 0) {
          return { ok: false, motivo: "Falta el tipo de carga para aplicar el mínimo" };
        }
        return {
          ok: true,
          cantidad: 1,
          valorUnitario: calculado,
          valor: calculado,
          detalle: `${pct} % sobre CIF ${formatoCOP(ctx.valorCif)}`,
        };
      }

      const minimo = minimoDe(item.minimos, ctx.tipoCarga);
      if (minimo !== null && calculado < minimo) {
        return {
          ok: true,
          cantidad: 1,
          valorUnitario: minimo,
          valor: minimo,
          detalle: `${pct} % sobre CIF = ${formatoCOP(calculado)}; aplica mínimo ${ETIQUETA_CARGA[ctx.tipoCarga]}`,
        };
      }
      return {
        ok: true,
        cantidad: 1,
        valorUnitario: calculado,
        valor: calculado,
        detalle: `${pct} % sobre CIF ${formatoCOP(ctx.valorCif)}`,
      };
    }

    case "PRIMERO_MAS_ADICIONAL": {
      const n = cantidadEvento ?? cantidadDeUnidad(item.unidad, ctx);
      if (n === null) return { ok: false, motivo: motivoFaltante(item.unidad) };
      if (n <= 0) return { ok: true, cantidad: 0, valorUnitario: item.valor, valor: 0n, detalle: "Sin unidades" };
      const adicional = item.valorAdicional ?? item.valor;
      const valor = item.valor + adicional * BigInt(n - 1);
      return {
        ok: true,
        cantidad: n,
        valorUnitario: item.valor,
        valor,
        detalle:
          n === 1
            ? `Primer ${ETIQUETA_UNIDAD[item.unidad]}`
            : `Primer ${ETIQUETA_UNIDAD[item.unidad]} ${formatoCOP(item.valor)} + ${n - 1} adicional${n - 1 === 1 ? "" : "es"} × ${formatoCOP(adicional)}`,
      };
    }

    case "ESPEJO_DE_COSTO": {
      if (!item.conceptoCosto) return { ok: false, motivo: "El ítem no dice qué costo espeja" };
      const costo = buscarCosto(ctx.costos, item.conceptoCosto);
      if (!costo) return { ok: false, motivo: `No hay un pago o factura de proveedor que contenga "${item.conceptoCosto}"` };
      return {
        ok: true,
        cantidad: 1,
        valorUnitario: costo.valor,
        valor: costo.valor,
        detalle: `Espejo de "${costo.concepto}"`,
      };
    }

    case "POR_TRAMO": {
      if (!item.tramos || item.tramos.length === 0) return { ok: false, motivo: "El ítem no tiene tramos configurados" };
      const n = cantidadEvento ?? cantidadDeUnidad(item.unidad, ctx);
      if (n === null) return { ok: false, motivo: motivoFaltante(item.unidad) };
      if (n <= 0) return { ok: true, cantidad: 0, valorUnitario: 0n, valor: 0n, detalle: "Sin unidades" };
      const tramo = tramoPara(item.tramos, n);
      if (!tramo) return { ok: false, motivo: `Ningún tramo cubre ${n} ${unidades(item.unidad, n)}` };
      const unitario = valorTramo(tramo);
      if (unitario === null) return { ok: false, motivo: "Un tramo tiene un valor que no es un entero en COP" };
      return {
        ok: true,
        cantidad: n,
        valorUnitario: unitario,
        valor: unitario * BigInt(n),
        detalle: `${formatoCOP(unitario)} × ${n} ${unidades(item.unidad, n)} (tramo ${etiquetaTramo(tramo, item.tramos, item.unidad)})`,
      };
    }
  }
}

export interface EjemploTramo {
  /** "1", "11–20", "21 o más" — mismo formato que usa la tabla de ítems. */
  rango: string;
  cantidad: number;
  valorUnitario: bigint;
  total: bigint;
}

/**
 * Ejemplo en vivo para el editor de escalas de volumen (B6, 22-sep): qué
 * escala le toca a `n` unidades y cuánto da en total. Reusa `tramoPara` — la
 * MISMA selección de tramo que usa `calcularLineasTarifa` — así que si el
 * motor cambia de criterio el ejemplo cambia con él. No agrega ni modifica
 * ningún cálculo existente.
 */
export function ejemploTramo(tramos: TramoTarifa[], n: number): EjemploTramo | null {
  if (n <= 0 || tramos.length === 0) return null;
  const tramo = tramoPara(tramos, n);
  if (!tramo) return null;
  const valorUnitario = valorTramo(tramo);
  if (valorUnitario === null) return null;

  const ordenados = [...tramos].sort((a, b) => {
    if (a.hasta === null) return 1;
    if (b.hasta === null) return -1;
    return a.hasta - b.hasta;
  });
  const idx = ordenados.indexOf(tramo);
  const anterior = idx > 0 ? (ordenados[idx - 1]?.hasta ?? 0) : 0;
  const rango =
    tramo.hasta === null ? `${anterior + 1} o más` : tramo.hasta === 1 ? "1" : `${anterior + 1}–${tramo.hasta}`;

  return { rango, cantidad: n, valorUnitario, total: valorUnitario * BigInt(n) };
}

/**
 * Calcula las líneas de la factura de venta a partir del tarifario y del
 * contexto del trámite. Determinista: mismo input → mismo output.
 */
export function calcularLineasTarifa(
  items: ItemTarifaCalculable[],
  ctx: ContextoTarifa,
): ResultadoTarifa {
  const lineas: LineaPropuesta[] = [];
  const pendientes: ItemPendiente[] = [];
  const manuales: ItemTarifaCalculable[] = [];
  const eventos = new Map(ctx.eventos.map((e) => [e.codigo, e.cantidad]));

  const ordenados = [...items].sort((a, b) => a.orden - b.orden || a.concepto.localeCompare(b.concepto));

  for (const item of ordenados) {
    if (item.disparador === "MANUAL") {
      manuales.push(item);
      continue;
    }

    let cantidadEvento: number | null = null;
    if (item.disparador === "EVENTO") {
      if (!item.eventoCodigo || !eventos.has(item.eventoCodigo)) continue;
      cantidadEvento = Math.max(1, eventos.get(item.eventoCodigo) ?? 1);
    }

    const calculo = calcularItem(item, ctx, cantidadEvento);
    if (!calculo.ok) {
      pendientes.push({ concepto: item.concepto, nombrePublico: item.nombrePublico, motivo: calculo.motivo });
      continue;
    }
    if (calculo.valor <= 0n) continue;

    lineas.push({
      concepto: item.concepto,
      nombrePublico: item.nombrePublico,
      siigoCodigo: item.siigoCodigo,
      cantidad: calculo.cantidad,
      valorUnitario: calculo.valorUnitario,
      valor: calculo.valor,
      aplicaIva: item.aplicaIva,
      origen: item.disparador === "EVENTO" ? "EVENTO" : "SIEMPRE",
      detalle: calculo.detalle,
    });
  }

  const total = lineas.reduce((acc, l) => acc + l.valor, 0n);
  const baseIva = lineas.filter((l) => l.aplicaIva).reduce((acc, l) => acc + l.valor, 0n);
  const totalConIva = total + porcentajeSobre(baseIva, 1_900);

  return { lineas, pendientes, manuales, total, totalConIva };
}

/**
 * ¿Está vigente el tarifario en la fecha dada? Comparación por día, inclusiva
 * en ambos extremos (Litoplas: 2-feb-2026 → 31-ene-2027).
 */
export function vigenteEn(
  tarifario: { vigenteDesde: Date; vigenteHasta: Date },
  fecha: Date,
): boolean {
  const dia = fecha.getTime();
  return dia >= tarifario.vigenteDesde.getTime() && dia <= finDelDia(tarifario.vigenteHasta).getTime();
}

function finDelDia(d: Date): Date {
  const f = new Date(d);
  f.setUTCHours(23, 59, 59, 999);
  return f;
}
