/**
 * Cuentas por pagar a proveedores v2 — núcleo PURO (sin BD, sin Node, BigInt).
 *
 * Contrato compartido por el dominio (P1/P2), las pantallas (P3–P6) y la
 * conciliación (P7). Se puede importar desde componentes cliente.
 *
 * Reglas (docs/CXP-PROVEEDORES.md, diseño §B.1 y §C):
 *   saldo  = valor − aplicado (Σ puente) − ajustes − compensado,  0 ≤ saldo ≤ valor
 *   estado = función del saldo: 0 → PAGADA; = valor → REGISTRADA; si no PARCIAL
 * En pantalla: Pendiente / Abonada / Pagada.
 *
 * Espejos de SQL (la fuente de verdad de las llaves es SQL, M2 de CxP v2):
 *   normalizarNumeroFactura ≡ cxp_normalizar_num
 *   nitBaseDe               ≡ cxp_nit_base   (SIN adivinar el DV)
 *   dvNit                   ≡ cxp_dv_nit
 *   claveProveedorDeFicha   ≡ cxp_clave_proveedor
 * Dinero: COP enteros (BigInt). Tolerancia 0.
 */

// ─── Errores de invariante ────────────────────────────────────────────────────

/**
 * Una cifra de CxP que no puede existir (saldo negativo, resumen que no cuadra).
 * Es un bug o un dato corrupto: nunca un error del usuario (status 500).
 */
export class InvarianteCxpError extends Error {
  public readonly status = 500;
  public readonly codigo = "INVARIANTE_CXP" as const;
  constructor(mensaje: string) {
    super(`Invariante de cuentas por pagar violado: ${mensaje}`);
    this.name = "InvarianteCxpError";
  }
}

// ─── Formato de dinero (mensajes) ─────────────────────────────────────────────

/** "$464.077" (COP enteros, punto de miles). Negativos: "−$161.377". */
export function formatoPesos(v: bigint): string {
  const negativo = v < 0n;
  const abs = negativo ? -v : v;
  const digitos = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "−" : ""}$${digitos}`;
}

// ─── Saldo, estado y etiqueta ─────────────────────────────────────────────────

export interface PartesFactura {
  /** Valor de la factura en COP (el que manda, también en facturas USD). */
  valor: bigint;
  /** Σ PagoTramiteFactura.monto. */
  aplicado: bigint;
  /** Σ AjusteFacturaProveedor.monto (v2: solo LEGADO). */
  ajustes: bigint;
  /** FacturaProveedor.montoCompensado (cruce de cuenta corriente). */
  compensado: bigint;
}

export type EstadoCxp = "REGISTRADA" | "PARCIAL" | "PAGADA";

export type EtiquetaCxp = "Pendiente" | "Abonada" | "Pagada" | "Cruzada" | "Pagada con ajuste";

/** Lo que falta por pagar. Lanza `InvarianteCxpError` si queda < 0 o > valor. */
export function saldoDe(p: PartesFactura): bigint {
  const saldo = p.valor - p.aplicado - p.ajustes - p.compensado;
  if (saldo < 0n) {
    throw new InvarianteCxpError(
      `saldo negativo (valor ${p.valor}, aplicado ${p.aplicado}, ajustes ${p.ajustes}, compensado ${p.compensado})`,
    );
  }
  if (saldo > p.valor) {
    throw new InvarianteCxpError(
      `saldo mayor que el valor (valor ${p.valor}, aplicado ${p.aplicado}, ajustes ${p.ajustes}, compensado ${p.compensado})`,
    );
  }
  return saldo;
}

/** 0 → PAGADA; = valor → REGISTRADA; si no PARCIAL. (Una factura de valor 0 es PAGADA.) */
export function estadoDe(p: PartesFactura): EstadoCxp {
  const saldo = saldoDe(p);
  if (saldo === 0n) return "PAGADA";
  if (saldo === p.valor) return "REGISTRADA";
  return "PARCIAL";
}

/**
 * Texto del chip. Saldo 0: con ajuste (v2: LEGADO) → "Pagada con ajuste"
 * ("Cerrada con diferencia: revisar"); con cruce → "Cruzada"; si no "Pagada".
 */
export function etiquetaDe(p: PartesFactura & { tieneAjusteLegado: boolean }): EtiquetaCxp {
  const estado = estadoDe(p);
  if (estado === "REGISTRADA") return "Pendiente";
  if (estado === "PARCIAL") return "Abonada";
  if (p.tieneAjusteLegado || p.ajustes > 0n) return "Pagada con ajuste";
  if (p.compensado > 0n) return "Cruzada";
  return "Pagada";
}

// ─── Validación de aplicaciones (los 4 caminos + conciliación) ───────────────

export interface SolicitudAplicacion {
  facturaProveedorId: string;
  /** COP > 0, nunca mayor que el saldo de la factura. */
  monto: bigint;
}

export interface FacturaEnValidacion extends PartesFactura {
  id: string;
  /**
   * Texto con el que la factura aparece en los mensajes: se recomienda pasar
   * `numeroFacturaVisible(numFactura, ficha.numFacturaConEspacio)`.
   */
  numFactura: string;
  tramiteId: string;
  beneficiarioId: string | null;
  /**
   * Clave del proveedor calculada DESDE LA FICHA: `claveProveedorDeFicha(beneficiario)`
   * ("NIT:<nitBase>" | "BEN:<id>"), NO la columna `FacturaProveedor.proveedorClave`
   * (que es NULL en los "duplicados heredados" y así no se podrían comparar).
   * null solo si la factura no tiene ficha.
   */
  proveedorClave: string | null;
  /** Nombre corto de la ficha o, si no tiene, su nombre (para los mensajes). */
  nombreProveedor: string;
}

export type ErrorAplicacion =
  | { codigo: "FACTURA_NO_ENCONTRADA"; facturaProveedorId: string }
  | { codigo: "FACTURA_REPETIDA"; numFactura: string }
  | { codigo: "FACTURA_DE_OTRO_DO"; numFactura: string }
  | { codigo: "FACTURA_SIN_PROVEEDOR"; numFactura: string }
  | { codigo: "FACTURA_DE_OTRO_PROVEEDOR"; numFactura: string; proveedorFactura: string; proveedorPago: string }
  | { codigo: "PROVEEDORES_MEZCLADOS"; numeros: string[] }
  | { codigo: "FACTURA_SIN_SALDO"; numFactura: string; proveedor: string }
  | { codigo: "MONTO_INVALIDO"; numFactura: string }
  | { codigo: "MONTO_EXCEDE_SALDO"; numFactura: string; monto: bigint; saldo: bigint };

export interface ProveedorDePago {
  /** Beneficiario (ficha) del pago. */
  id: string;
  nombre: string;
  /** `claveProveedorDeFicha` de esa ficha. */
  clave: string | null;
}

export type ResultadoValidacionAplicaciones =
  | { ok: true; saldosDespues: Map<string, bigint> }
  | { ok: false; errores: ErrorAplicacion[] };

/**
 * Valida un conjunto de aplicaciones contra saldos frescos (ya bloqueados por
 * el llamador). Devuelve TODOS los errores, no solo el primero.
 *
 * - `tramiteIdPago` (pago simple): todas las facturas deben ser de ese DO.
 * - `proveedoresPago` (pago simple): cada factura debe ser de uno de los
 *   beneficiarios del pago (misma clave NIT). Vacío/ausente = sin control aquí
 *   (el llamador completa los beneficiarios con el de la factura).
 * - `proveedorBloque` (bloque / compensación): todas del proveedor del bloque.
 * - Siempre: un pago va a UN proveedor (`PROVEEDORES_MEZCLADOS`).
 */
export function validarAplicaciones(a: {
  solicitudes: SolicitudAplicacion[];
  facturas: ReadonlyMap<string, FacturaEnValidacion>;
  tramiteIdPago?: string;
  proveedoresPago?: ProveedorDePago[];
  proveedorBloque?: { clave: string; nombre: string };
}): ResultadoValidacionAplicaciones {
  const errores: ErrorAplicacion[] = [];
  const saldosDespues = new Map<string, bigint>();
  const vistas = new Set<string>();
  /** clave → primer N° de factura visto con esa clave (para PROVEEDORES_MEZCLADOS). */
  const porClave = new Map<string, string>();

  for (const s of a.solicitudes) {
    const f = a.facturas.get(s.facturaProveedorId);
    if (!f) {
      errores.push({ codigo: "FACTURA_NO_ENCONTRADA", facturaProveedorId: s.facturaProveedorId });
      continue;
    }
    if (vistas.has(f.id)) {
      errores.push({ codigo: "FACTURA_REPETIDA", numFactura: f.numFactura });
      continue;
    }
    vistas.add(f.id);

    if (a.tramiteIdPago !== undefined && f.tramiteId !== a.tramiteIdPago) {
      errores.push({ codigo: "FACTURA_DE_OTRO_DO", numFactura: f.numFactura });
    }

    const clave = f.beneficiarioId === null ? null : f.proveedorClave ?? `BEN:${f.beneficiarioId}`;
    if (clave === null) {
      errores.push({ codigo: "FACTURA_SIN_PROVEEDOR", numFactura: f.numFactura });
    } else {
      if (!porClave.has(clave)) porClave.set(clave, f.numFactura);

      if (a.proveedorBloque && clave !== a.proveedorBloque.clave) {
        errores.push({
          codigo: "FACTURA_DE_OTRO_PROVEEDOR",
          numFactura: f.numFactura,
          proveedorFactura: f.nombreProveedor,
          proveedorPago: a.proveedorBloque.nombre,
        });
      }

      if (a.proveedoresPago && a.proveedoresPago.length > 0) {
        const coincide = a.proveedoresPago.some(
          (p) => (p.clave ?? `BEN:${p.id}`) === clave || p.id === f.beneficiarioId,
        );
        if (!coincide) {
          errores.push({
            codigo: "FACTURA_DE_OTRO_PROVEEDOR",
            numFactura: f.numFactura,
            proveedorFactura: f.nombreProveedor,
            proveedorPago: a.proveedoresPago.map((p) => p.nombre).join(" / "),
          });
        }
      }
    }

    if (s.monto <= 0n) {
      errores.push({ codigo: "MONTO_INVALIDO", numFactura: f.numFactura });
      continue;
    }

    const saldo = saldoDe(f);
    if (saldo === 0n) {
      errores.push({ codigo: "FACTURA_SIN_SALDO", numFactura: f.numFactura, proveedor: f.nombreProveedor });
      continue;
    }
    if (s.monto > saldo) {
      errores.push({ codigo: "MONTO_EXCEDE_SALDO", numFactura: f.numFactura, monto: s.monto, saldo });
      continue;
    }
    saldosDespues.set(f.id, saldo - s.monto);
  }

  if (porClave.size > 1) {
    errores.push({ codigo: "PROVEEDORES_MEZCLADOS", numeros: [...porClave.values()] });
  }

  return errores.length > 0 ? { ok: false, errores } : { ok: true, saldosDespues };
}

// ─── Reparto FIFO (entrada heredada `facturaProveedorIds`) ───────────────────

export interface FacturaParaReparto {
  id: string;
  saldo: bigint;
  fecha: Date;
  createdAt: Date;
}

/**
 * Reparte `valor` entre las facturas por (fecha, createdAt, id), cada una hasta
 * su saldo. `aplicaciones` solo trae montos > 0; `sinMonto` = ids pedidos que
 * quedaron en 0 (→ el llamador responde `FACTURA_SIN_MONTO`); `sobrante` > 0 ⇒
 * el valor supera Σ saldos (→ `PAGO_EXCEDE_SALDO`). Nunca enlaza a medias en
 * silencio: el llamador decide.
 */
export function repartirFIFO(
  valor: bigint,
  facturas: FacturaParaReparto[],
): { aplicaciones: SolicitudAplicacion[]; sobrante: bigint; sinMonto: string[] } {
  if (valor < 0n) throw new InvarianteCxpError(`valor a repartir negativo (${valor})`);
  const ordenadas = [...facturas].sort(
    (x, y) =>
      x.fecha.getTime() - y.fecha.getTime() ||
      x.createdAt.getTime() - y.createdAt.getTime() ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  let resto = valor;
  const aplicaciones: SolicitudAplicacion[] = [];
  const sinMonto: string[] = [];
  for (const f of ordenadas) {
    if (f.saldo < 0n) throw new InvarianteCxpError(`saldo negativo en la factura ${f.id}`);
    const monto = resto < f.saldo ? resto : f.saldo;
    if (monto > 0n) {
      aplicaciones.push({ facturaProveedorId: f.id, monto });
      resto -= monto;
    } else {
      sinMonto.push(f.id);
    }
  }
  return { aplicaciones, sobrante: resto, sinMonto };
}

// ─── Prorrateo exacto y costo bancario (D-1, R8) ─────────────────────────────

/**
 * Reparte `total` proporcional a `pesos` con restos mayores (empate → índice
 * menor). Σ resultado = total, siempre. Si todos los pesos son 0 reparte por
 * partes iguales. Lanza si total < 0, algún peso < 0 o no hay pesos y total > 0.
 */
export function prorratearExacto(total: bigint, pesos: bigint[]): bigint[] {
  if (total < 0n) throw new InvarianteCxpError(`total a prorratear negativo (${total})`);
  if (pesos.some((p) => p < 0n)) throw new InvarianteCxpError("peso negativo en el prorrateo");
  if (pesos.length === 0) {
    if (total === 0n) return [];
    throw new InvarianteCxpError(`no hay entre quién prorratear ${total}`);
  }
  const efectivos = pesos.every((p) => p === 0n) ? pesos.map(() => 1n) : pesos;
  const suma = efectivos.reduce((acc, p) => acc + p, 0n);
  const base = efectivos.map((p) => (total * p) / suma);
  const restos = efectivos.map((p, i) => ({ i, r: (total * p) % suma }));
  let faltante = total - base.reduce((acc, b) => acc + b, 0n);
  restos.sort((x, y) => (x.r > y.r ? -1 : x.r < y.r ? 1 : x.i - y.i));
  for (const { i } of restos) {
    if (faltante === 0n) break;
    base[i] += 1n;
    faltante -= 1n;
  }
  return base;
}

export type ReglaCostoBancario = "GALCOMEX" | "PRIMER_DO" | "PRORRATEADO";

export interface DoParaCosto {
  /**
   * Peso del prorrateo: lo que el bloque le cobra al cliente de ese DO (Σ
   * montos de sus facturas que se cobran; la asesoría NO SE COBRA no pesa).
   */
  valor: bigint;
  /**
   * Cliente SIN `factura_conceptos_iva` y borrador del DO ausente o en
   * BORRADOR/EN_REVISION (D-1). Lo calcula el llamador.
   */
  puedeAbsorber: boolean;
}

/**
 * Costo bancario por PagoTramite del bloque, en el mismo orden que `dos`
 * (ordenados por consecutivo). PRIMER_DO → todo al primero que puede
 * absorberlo; PRORRATEADO → prorrateo exacto solo entre los que pueden;
 * GALCOMEX o ninguno puede → todo 0. Σ = costo, o 0 si lo asume Galcomex.
 */
export function costoPorPago(regla: ReglaCostoBancario, costo: bigint, dos: DoParaCosto[]): bigint[] {
  if (costo < 0n) throw new InvarianteCxpError(`costo bancario negativo (${costo})`);
  const ceros = dos.map(() => 0n);
  if (regla === "GALCOMEX" || costo === 0n) return ceros;
  const indices = dos.flatMap((d, i) => (d.puedeAbsorber ? [i] : []));
  if (indices.length === 0) return ceros;
  if (regla === "PRIMER_DO") {
    ceros[indices[0]] = costo;
    return ceros;
  }
  const partes = prorratearExacto(
    costo,
    indices.map((i) => dos[i].valor),
  );
  indices.forEach((i, k) => {
    ceros[i] = partes[k];
  });
  return ceros;
}

/** Defecto del bloque (D-1): PRIMER_DO si algún DO puede absorber el costo; si no GALCOMEX. */
export function reglaCostoPorDefecto(dos: { puedeAbsorber: boolean }[]): "GALCOMEX" | "PRIMER_DO" {
  return dos.some((d) => d.puedeAbsorber) ? "PRIMER_DO" : "GALCOMEX";
}

/**
 * Regla de `puedeAbsorber` (D-1) en un solo lugar: el cliente del DO no usa el
 * formato `factura_conceptos_iva` y el borrador del DO no existe o sigue en
 * BORRADOR/EN_REVISION.
 */
export function puedeAbsorberCosto(i: {
  clienteUsaConceptosIva: boolean;
  estadoBorrador: "BORRADOR" | "EN_REVISION" | "APROBADO" | "FACTURADO" | null;
}): boolean {
  if (i.clienteUsaConceptosIva) return false;
  return i.estadoBorrador === null || i.estadoBorrador === "BORRADOR" || i.estadoBorrador === "EN_REVISION";
}

// ─── Resumen del proveedor (ficha y /pagos) ──────────────────────────────────

export interface ResumenCxp {
  /** Σ valor ("Total de sus facturas"). */
  facturado: bigint;
  pagado: bigint;
  ajustado: bigint;
  cruzado: bigint;
  /** Σ saldos ("Le debemos"). */
  pendiente: bigint;
  /** Pagos activos a una ficha de este proveedor que no cubren ninguna factura. */
  pagadoSinFactura: bigint;
  nPendientes: number;
  nAbonadas: number;
  nPagadas: number;
}

/** Lanza `InvarianteCxpError` si facturado ≠ pagado + ajustado + cruzado + pendiente (I1). */
export function resumenProveedor(filas: PartesFactura[], pagadoSinFactura: bigint): ResumenCxp {
  const r: ResumenCxp = {
    facturado: 0n,
    pagado: 0n,
    ajustado: 0n,
    cruzado: 0n,
    pendiente: 0n,
    pagadoSinFactura,
    nPendientes: 0,
    nAbonadas: 0,
    nPagadas: 0,
  };
  for (const f of filas) {
    r.facturado += f.valor;
    r.pagado += f.aplicado;
    r.ajustado += f.ajustes;
    r.cruzado += f.compensado;
    r.pendiente += saldoDe(f);
    const estado = estadoDe(f);
    if (estado === "REGISTRADA") r.nPendientes += 1;
    else if (estado === "PARCIAL") r.nAbonadas += 1;
    else r.nPagadas += 1;
  }
  if (r.facturado !== r.pagado + r.ajustado + r.cruzado + r.pendiente) {
    throw new InvarianteCxpError(
      `resumen no cuadra: facturado ${r.facturado} ≠ pagado ${r.pagado} + ajustado ${r.ajustado} + cruzado ${r.cruzado} + pendiente ${r.pendiente}`,
    );
  }
  return r;
}

// ─── Número de factura ────────────────────────────────────────────────────────

/** Espejo de SQL `cxp_normalizar_num`: mayúsculas y solo A-Z0-9. "FE- 12481" → "FE12481". "" si no queda nada. */
export function normalizarNumeroFactura(n: string): string {
  return n.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Solo dígitos, sin ceros a la izquierda: "FE-012481" → "12481" (aviso de posible duplicado, R12). */
export function digitosSignificativos(n: string): string {
  const digitos = n.replace(/[^0-9]/g, "");
  if (digitos === "") return "";
  return digitos.replace(/^0+/, "") || "0";
}

/**
 * Número como lo escribe el Excel de Camila / la factura de venta.
 * - `conEspacio` (ficha marcada «Numerar como FE 11298»): prefijo de letras +
 *   espacio + resto: "FE-12481" | "fe12481" | "FE- 12481" → "FE 12481".
 * - sin la marca: se respeta lo digitado (solo trim y espacios dobles):
 *   "REG-50151039", "71388844".
 */
export function numeroFacturaVisible(n: string, conEspacio: boolean): string {
  const limpio = n.trim().replace(/\s+/g, " ");
  if (!conEspacio) return limpio;
  const mayus = limpio.toUpperCase();
  const m = /^([A-Z]+)[\s\-_.]*(\d.*)$/.exec(mayus);
  if (!m) return mayus;
  return `${m[1]} ${m[2].replace(/\s+/g, "")}`;
}

/** DO corto del Excel: (2026, 69) → "26-0069". */
export function doCorto(anio: number, numero: number): string {
  return `${String(anio % 100).padStart(2, "0")}-${String(numero).padStart(4, "0")}`;
}

// ─── NIT (sin adivinar el DV) ─────────────────────────────────────────────────

/**
 * Espejo TS de SQL `cxp_nit_base` (v1.1): quita "NIT", puntos y espacios; el DV
 * SOLO se separa si viene separado con guion ("800.154.017-8" → "800154017").
 * Una cadena de solo dígitos se toma completa ("800154017" → "800154017",
 * "8001540178" → "8001540178"). Con letras → null (no es NIT colombiano).
 */
export function nitBaseDe(nit: string | null): string | null {
  if (nit === null) return null;
  // btrim de PostgreSQL: solo espacios.
  const s = nit.replace(/^ +| +$/g, "").toUpperCase().replace(/^NIT[\s.:]*/, "");
  if (s === "" || /[^0-9.\s-]/.test(s)) return null;
  const base = /^[0-9.\s]+-\s*[0-9]$/.test(s)
    ? s.split("-")[0].replace(/[^0-9]/g, "")
    : s.replace(/[^0-9]/g, "");
  const sinCeros = base.replace(/^0+/, "");
  return sinCeros === "" ? null : sinCeros;
}

const PESOS_DV = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/** Dígito de verificación DIAN (espejo de `cxp_dv_nit`). 800154017 → 8. Lanza si `base` no son 1–15 dígitos. */
export function dvNit(base: string): number {
  if (!/^[0-9]{1,15}$/.test(base)) {
    throw new RangeError(`NIT base inválido para calcular el DV: "${base}"`);
  }
  let suma = 0;
  for (let i = 0; i < base.length; i++) {
    suma += Number(base[base.length - 1 - i]) * PESOS_DV[i];
  }
  const resto = suma % 11;
  return resto === 0 || resto === 1 ? resto : 11 - resto;
}

/**
 * NIT base "parecidos" para el aviso de ficha duplicada (no bloquea):
 * [base, base sin el último dígito, base + su DV]. [] si no es NIT colombiano.
 */
export function candidatosNitParecido(nit: string): string[] {
  const base = nitBaseDe(nit);
  if (base === null) return [];
  const candidatos = [base];
  if (base.length > 1) candidatos.push(base.slice(0, -1));
  if (base.length <= 15) candidatos.push(`${base}${dvNit(base)}`);
  return [...new Set(candidatos)];
}

/** Espejo de SQL `cxp_clave_proveedor`: "NIT:<nitBase>" o "BEN:<id>". */
export function claveProveedorDeFicha(ficha: { id: string; nitBase: string | null }): string {
  return ficha.nitBase !== null ? `NIT:${ficha.nitBase}` : `BEN:${ficha.id}`;
}

// ─── USD (R14, D-4) ───────────────────────────────────────────────────────────

/** COP sugerido = USD × TRM, redondeo mitad arriba al peso. 13100 × 371050 → 486.076. */
export function copDesdeUsd(valorOrigenCentavos: bigint, trmCentavos: bigint): bigint {
  if (valorOrigenCentavos < 0n || trmCentavos < 0n) {
    throw new InvarianteCxpError("valor USD o TRM negativos");
  }
  return (valorOrigenCentavos * trmCentavos + 5000n) / 10000n;
}

/** Diferencia máxima (%) entre el valor en pesos escrito y USD × TRM sin pedir confirmación. */
export const USD_TOLERANCIA_PORCENTAJE = 5n;

/**
 * Compara el valor en pesos escrito con USD × TRM. `diferenciaPorcentaje` =
 * |escrito − sugerido| / sugerido × 100 redondeado al entero (mitad arriba);
 * `lejos` si supera `USD_TOLERANCIA_PORCENTAJE` (→ `USD_VALOR_LEJOS_DE_TRM`).
 */
export function evaluarValorUsd(i: {
  valorOrigenCentavos: bigint;
  trmCentavos: bigint;
  valor: bigint;
}): { sugerido: bigint; diferenciaPorcentaje: bigint; lejos: boolean } {
  const sugerido = copDesdeUsd(i.valorOrigenCentavos, i.trmCentavos);
  const diferencia = i.valor > sugerido ? i.valor - sugerido : sugerido - i.valor;
  if (sugerido === 0n) {
    return { sugerido, diferenciaPorcentaje: diferencia === 0n ? 0n : 100n, lejos: diferencia > 0n };
  }
  const diferenciaPorcentaje = (diferencia * 100n * 2n + sugerido) / (2n * sugerido);
  return {
    sugerido,
    diferenciaPorcentaje,
    lejos: diferencia * 100n > USD_TOLERANCIA_PORCENTAJE * sugerido,
  };
}

/** "131,00" desde centavos de dólar; "3.710,50" desde centavos de TRM. */
export function formatoCentavos(v: bigint): string {
  const negativo = v < 0n;
  const abs = negativo ? -v : v;
  const enteros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cent = (abs % 100n).toString().padStart(2, "0");
  return `${negativo ? "−" : ""}${enteros},${cent}`;
}
