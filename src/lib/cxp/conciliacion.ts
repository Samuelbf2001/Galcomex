/**
 * CxP v2 — Conciliación con el Excel MAESTRO de Camila (diseño §E, paquete P7b).
 *
 * El Excel de cartera de cada proveedor ("CARTERA ALMACARGA.xlsx",
 * "CARTERA EXPRESS.xlsx") manda: si dice que una factura se pagó el 23-abr, el
 * sistema debe mostrarla Pagada. Este módulo compara fila por fila y, en modo
 * aplicar, registra lo que falta como pagos HISTÓRICOS (costo 0, sin
 * comprobante, marca `esHistorico`), agrupados en un bloque por fecha de pago.
 *
 * Dos capas en el mismo archivo:
 *   · PURA (sin BD): lectura de la hoja, clasificación de cada fila, plan de
 *     bloques/enlaces/importaciones y reportes Markdown + CSV. Probada sin BD.
 *   · BD: carga lo necesario del sistema y ejecuta el plan SOLO por las
 *     puertas del dominio (`crearPagoMultiDO` histórico, `enlazarPagoExistente`,
 *     `crearFacturaProveedor`). Nunca escribe el puente ni el estado a mano.
 *
 * Nunca paga dos veces:
 *   1. Solo son candidatas las facturas con saldo = valor (Pendientes) y DO no cerrado.
 *   2. `PAGO_PREVIO_SIN_ENLAZAR` se evalúa ANTES que la candidata: si el DO ya
 *      tiene un pago al mismo proveedor (o que nombra la factura) con plata sin
 *      aplicar, esa fila no se paga; se propone enlazar ese pago (solo con
 *      `--enlazar-previos <ids>` explícito).
 *   3. `crearPagoMultiDO` vuelve a bloquear y validar el saldo (y el guardián
 *      de BD lo repite); la clave de idempotencia es determinista por
 *      (archivo, NIT, fecha, facturas), así un reintento no crea otro bloque.
 *   4. Una segunda corrida ya encuentra saldo 0 (`PAGADA_OK`): 0 cambios.
 */

import { createHash } from "node:crypto";

import { type CanalPago, type EstadoTramite, Prisma, type PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";

import { cargarContextoDos } from "@/lib/cxp/pagabilidad-bd";
import { resumenPorProveedor } from "@/lib/cxp/estado-cuenta";
import {
  digitosSignificativos,
  doCorto,
  formatoPesos,
  normalizarNumeroFactura,
} from "@/lib/cxp/saldos";
import { prisma as prismaGlobal } from "@/lib/db/prisma";
import { crearFacturaProveedor } from "@/lib/facturas-proveedor/service";
import { crearPagoMultiDO, enlazarPagoExistente } from "@/lib/pagos/service";

// ═════════════════════════════════════════════════════════════════════════════
// CAPA PURA
// ═════════════════════════════════════════════════════════════════════════════

/** Una fila de la hoja de cartera (FACTURA | PROVEEDOR | DO | FECHA | TOTAL | PAGO). */
export interface FilaCartera {
  /** Nombre del archivo (sin carpeta): entra en la clave de idempotencia. */
  archivo: string;
  /** Fila de Excel (1 = primera fila de la hoja). */
  fila: number;
  /** Como viene: "FE 11298". */
  factura: string;
  /** `normalizarNumeroFactura`: "FE11298". */
  numeroNormalizado: string;
  /** Columna PROVEEDOR del Excel: es la MARCA del cliente (SRF, BOBST), no el proveedor. */
  marca: string;
  /** Como viene: "26-0069". */
  doTexto: string;
  doAnio: number | null;
  doNumero: number | null;
  /** Fecha de la factura, fecha-calendario "YYYY-MM-DD". */
  fecha: string | null;
  /** TOTAL exacto en centavos (502.801,45 → 50280145n). */
  totalCentavos: bigint;
  /** PAGO: fecha-calendario "YYYY-MM-DD" o null si la celda está vacía (pendiente). */
  pago: string | null;
}

export interface ErrorLectura {
  archivo: string;
  fila: number;
  motivo: string;
}

const ENCABEZADOS = ["FACTURA", "PROVEEDOR", "DO", "FECHA", "TOTAL", "PAGO"] as const;
type Encabezado = (typeof ENCABEZADOS)[number];

function textoCelda(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Celda de fecha → fecha-calendario "YYYY-MM-DD" sin corrimiento de zona:
 * número de serie de Excel (vía `XLSX.SSF.parse_date_code`), `Date` (se toma
 * el día UTC) o texto "YYYY-MM-DD". Vacía → null. Otra cosa → error.
 */
export function fechaCalendarioDeCelda(v: unknown): { ok: true; fecha: string | null } | { ok: false } {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { ok: true, fecha: null };
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const d = XLSX.SSF.parse_date_code(Math.floor(v));
    if (!d || !d.y) return { ok: false };
    return { ok: true, fecha: ymd(d.y, d.m, d.d) };
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { ok: true, fecha: ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) };
  }
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) return { ok: true, fecha: ymd(Number(m[1]), Number(m[2]), Number(m[3])) };
  }
  return { ok: false };
}

/** TOTAL → centavos exactos. Solo números (así vienen los Excel de Camila). */
export function centavosDeCelda(v: unknown): bigint | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return BigInt(Math.round(v * 100));
}

/** "26-0069" → { anio: 2026, numero: 69 }. */
export function parsearDoExcel(texto: string): { anio: number; numero: number } | null {
  const m = /^(\d{2})-(\d{1,5})$/.exec(texto.trim());
  if (!m) return null;
  return { anio: 2000 + Number(m[1]), numero: Number(m[2]) };
}

/**
 * Lee las filas crudas de una hoja (`sheet_to_json(ws, { header: 1, raw: true })`).
 * Busca la fila de encabezado FACTURA | PROVEEDOR | DO | FECHA | TOTAL | PAGO
 * (fila 3 en los dos archivos de Camila); las filas vacías se saltan y las que
 * no se entienden van a `errores` (nunca se adivinan).
 */
export function leerHojaCartera(
  filas: readonly (readonly unknown[])[],
  archivo: string,
): { filas: FilaCartera[]; errores: ErrorLectura[] } {
  const errores: ErrorLectura[] = [];
  const salida: FilaCartera[] = [];

  let filaEncabezado = -1;
  const col = new Map<Encabezado, number>();
  for (let i = 0; i < filas.length && filaEncabezado < 0; i++) {
    const celdas = filas[i].map((c) => textoCelda(c).toUpperCase());
    if (ENCABEZADOS.every((h) => celdas.includes(h))) {
      filaEncabezado = i;
      for (const h of ENCABEZADOS) col.set(h, celdas.indexOf(h));
    }
  }
  if (filaEncabezado < 0) {
    errores.push({ archivo, fila: 0, motivo: `No se encontró la fila de encabezado ${ENCABEZADOS.join(" | ")}.` });
    return { filas: salida, errores };
  }

  for (let i = filaEncabezado + 1; i < filas.length; i++) {
    const r = filas[i];
    const celda = (h: Encabezado) => r[col.get(h)!];
    const numeroFila = i + 1;
    if (r.every((c) => textoCelda(c) === "")) continue;

    const factura = textoCelda(celda("FACTURA"));
    if (factura === "") {
      errores.push({ archivo, fila: numeroFila, motivo: "Fila con datos pero sin número de FACTURA." });
      continue;
    }
    const numeroNormalizado = normalizarNumeroFactura(factura);
    if (numeroNormalizado === "") {
      errores.push({ archivo, fila: numeroFila, motivo: `FACTURA ilegible: "${factura}".` });
      continue;
    }
    const totalCentavos = centavosDeCelda(celda("TOTAL"));
    if (totalCentavos === null || totalCentavos <= 0n) {
      errores.push({ archivo, fila: numeroFila, motivo: `TOTAL no es un número positivo en ${factura}.` });
      continue;
    }
    const fecha = fechaCalendarioDeCelda(celda("FECHA"));
    if (!fecha.ok) {
      errores.push({ archivo, fila: numeroFila, motivo: `FECHA ilegible en ${factura}.` });
      continue;
    }
    const pago = fechaCalendarioDeCelda(celda("PAGO"));
    if (!pago.ok) {
      errores.push({
        archivo,
        fila: numeroFila,
        motivo: `PAGO de ${factura} no es una fecha ("${textoCelda(celda("PAGO"))}"): revisar a mano.`,
      });
      continue;
    }
    const doTexto = textoCelda(celda("DO"));
    const d = parsearDoExcel(doTexto);
    salida.push({
      archivo,
      fila: numeroFila,
      factura,
      numeroNormalizado,
      marca: textoCelda(celda("PROVEEDOR")),
      doTexto,
      doAnio: d?.anio ?? null,
      doNumero: d?.numero ?? null,
      fecha: fecha.fecha,
      totalCentavos,
      pago: pago.fecha,
    });
  }
  return { filas: salida, errores };
}

// ─── Datos del sistema (los arma la capa de BD; las pruebas los construyen a mano) ──

export interface FacturaSistema {
  id: string;
  /** Como está guardada ("FE-11298"). */
  numFactura: string;
  numeroNormalizado: string;
  beneficiarioId: string | null;
  tramiteId: string;
  consecutivo: string;
  doAnio: number;
  doNumero: number;
  tramiteEstado: EstadoTramite;
  /** `proveedorCliente` del DO (la marca: informativa frente a la columna PROVEEDOR del Excel). */
  marcaDo: string | null;
  valor: bigint;
  aplicado: bigint;
  ajustes: bigint;
  compensado: bigint;
  fecha: string;
  createdAt: Date;
}

export interface PagoSistema {
  id: string;
  tramiteId: string;
  concepto: string;
  numSoporte: string | null;
  valor: bigint;
  /** Σ monto del puente de este pago (a cualquier factura). */
  aplicado: bigint;
  /** Alguna ficha del pago tiene el NIT base del proveedor que se concilia. */
  delProveedor: boolean;
  /** El pago no tiene ninguna ficha de pago enlazada. */
  sinBeneficiario: boolean;
  fechaRealPago: string | null;
  createdAt: Date;
}

export interface TramiteSistema {
  id: string;
  consecutivo: string;
  ciudad: string;
  anio: number;
  numero: number;
  estado: EstadoTramite;
  marca: string | null;
}

// ─── Clasificación ────────────────────────────────────────────────────────────

export const CATEGORIAS = [
  "PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA",
  "PAGO_PREVIO_SIN_ENLAZAR",
  "PAGADA_OK",
  "PENDIENTE_EN_AMBOS",
  "PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL",
  "ABONADA_EN_SISTEMA",
  "DO_CERRADO",
  "DO_DISTINTO",
  "VALOR_DISTINTO",
  "NUMERO_PARECIDO",
  "VARIAS_EN_SISTEMA",
  "REPETIDA_EN_EXCEL",
  "NO_EN_SISTEMA",
  "SOLO_EN_SISTEMA",
] as const;
export type CategoriaConciliacion = (typeof CATEGORIAS)[number];

/**
 * Notas que NO cambian la categoría:
 *  · CENTAVOS: el Excel trae centavos (< $1 de diferencia, p. ej. 502.801,45 vs
 *    502.801). Se acepta; el valor exacto queda en el CSV para la fase de centavos (§F).
 *  · MARCA_DISTINTA: la columna PROVEEDOR (marca) no aparece en la marca del DO.
 *  · DO_AMBIGUO: el DO del Excel existe en BAQ y en otra ciudad.
 *  · DO_NO_EXISTE: el DO del Excel no está en el sistema.
 */
export type NotaConciliacion = "CENTAVOS" | "MARCA_DISTINTA" | "DO_AMBIGUO" | "DO_NO_EXISTE";

/** Propuesta de enlazar una factura a un pago que ya salió (PAGO_PREVIO_SIN_ENLAZAR). */
export interface PropuestaEnlace {
  pagoId: string;
  concepto: string;
  valor: bigint;
  /** Lo que le queda al pago sin aplicar ANTES de esta propuesta. */
  disponible: bigint;
  /** Lo que se enlazaría a esta factura = min(disponible, saldo). */
  monto: bigint;
  motivo: string;
}

export interface FilaConciliada {
  /** null solo en SOLO_EN_SISTEMA. */
  fila: FilaCartera | null;
  categoria: CategoriaConciliacion;
  notas: NotaConciliacion[];
  detalle: string;
  factura: FacturaSistema | null;
  saldo: bigint | null;
  /** DO del Excel resuelto en el sistema (para NO_EN_SISTEMA e importación). */
  tramiteExcel: TramiteSistema | null;
  /** TOTAL del Excel (centavos) − valor del sistema × 100. */
  diferenciaCentavos: bigint | null;
  propuestaEnlace: PropuestaEnlace | null;
}

export interface EntradaClasificacion {
  nitBase: string;
  nombreProveedor: string;
  filas: FilaCartera[];
  facturas: FacturaSistema[];
  pagos: PagoSistema[];
  tramites: TramiteSistema[];
  /** Pagos que un humano revisó y NO corresponden a este proveedor (`--ignorar-previos`). */
  ignorarPagos?: ReadonlySet<string>;
}

export interface ResultadoClasificacion {
  nitBase: string;
  nombreProveedor: string;
  filas: FilaConciliada[];
  conteo: Record<CategoriaConciliacion, number>;
  /** Por DO afectado (candidatas y pagos previos): plata de pagos al proveedor que no cubre ninguna factura. */
  pagadoSinFacturaPorDo: { tramiteId: string; consecutivo: string; monto: bigint }[];
}

function saldoFactura(f: FacturaSistema): bigint {
  const s = f.valor - f.aplicado - f.ajustes - f.compensado;
  return s < 0n ? 0n : s;
}

/** DO del Excel → trámite de importación: BAQ primero; BAQ + otra ciudad = ambiguo. */
export function resolverDoExcel(
  anio: number | null,
  numero: number | null,
  tramites: readonly TramiteSistema[],
): { tramite: TramiteSistema | null; ambiguo: boolean } {
  if (anio === null || numero === null) return { tramite: null, ambiguo: false };
  const iguales = tramites.filter((t) => t.anio === anio && t.numero === numero);
  if (iguales.length === 0) return { tramite: null, ambiguo: false };
  if (iguales.length === 1) return { tramite: iguales[0], ambiguo: false };
  return { tramite: null, ambiguo: true };
}

/** ¿El texto nombra este número de factura? ("Pago FE-11298", "FACT 11298", "FE11298"). */
export function textoNombraFactura(texto: string | null, numFactura: string): boolean {
  if (!texto) return false;
  const norm = normalizarNumeroFactura(numFactura);
  if (norm !== "" && normalizarNumeroFactura(texto).includes(norm)) return true;
  const digitos = digitosSignificativos(numFactura);
  if (digitos.length < 4) return false; // números cortos darían falsos positivos
  return new RegExp(`(^|\\D)0*${digitos}(\\D|$)`).test(texto);
}

function marcaCoincide(marcaExcel: string, marcaDo: string | null): boolean {
  if (!marcaDo || marcaExcel.trim() === "") return true; // sin dato no se puede decir que difiere
  const a = normalizarNumeroFactura(marcaExcel);
  const b = normalizarNumeroFactura(marcaDo);
  return a === "" || b.includes(a);
}

/**
 * Clasifica cada fila del Excel contra el sistema (una categoría por fila) y
 * agrega `SOLO_EN_SISTEMA` para las facturas del proveedor que el Excel no trae.
 * Orden de decisión para una factura encontrada:
 *   REPETIDA_EN_EXCEL → DO_DISTINTO → VALOR_DISTINTO (≥ $1) → según saldo y PAGO:
 *   Excel pagada: saldo 0 → PAGADA_OK; DO cerrado → DO_CERRADO;
 *     pago previo sin enlazar → PAGO_PREVIO_SIN_ENLAZAR (ANTES que la candidata);
 *     abonada → ABONADA_EN_SISTEMA; pendiente → PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA.
 *   Excel pendiente: saldo 0 → PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL;
 *     abonada → ABONADA_EN_SISTEMA; si no → PENDIENTE_EN_AMBOS.
 */
export function clasificarCartera(e: EntradaClasificacion): ResultadoClasificacion {
  const ignorar = e.ignorarPagos ?? new Set<string>();
  const porNumero = new Map<string, FacturaSistema[]>();
  for (const f of e.facturas) {
    const lista = porNumero.get(f.numeroNormalizado) ?? [];
    lista.push(f);
    porNumero.set(f.numeroNormalizado, lista);
  }
  const usadas = new Set<string>();
  const vistasExcel = new Set<string>();
  /** Números exactos que trae el Excel: una factura así nunca se ofrece como "parecida" de otra fila. */
  const numerosExcel = new Set(e.filas.map((f) => f.numeroNormalizado));
  /** Lo que ya se prometió de cada pago previo (una propuesta no puede pasar su disponible). */
  const prometido = new Map<string, bigint>();
  const salida: FilaConciliada[] = [];

  for (const fila of e.filas) {
    const notas: NotaConciliacion[] = [];
    const { tramite: tramiteExcel, ambiguo } = resolverDoExcel(fila.doAnio, fila.doNumero, e.tramites);
    if (ambiguo) notas.push("DO_AMBIGUO");
    else if (!tramiteExcel && fila.doAnio !== null) notas.push("DO_NO_EXISTE");
    const base = { fila, notas, tramiteExcel, propuestaEnlace: null as PropuestaEnlace | null };

    if (vistasExcel.has(fila.numeroNormalizado)) {
      salida.push({
        ...base,
        categoria: "REPETIDA_EN_EXCEL",
        detalle: `${fila.factura} aparece más de una vez en ${fila.archivo}: solo cuenta la primera fila.`,
        factura: null,
        saldo: null,
        diferenciaCentavos: null,
      });
      continue;
    }
    vistasExcel.add(fila.numeroNormalizado);

    const candidatas = porNumero.get(fila.numeroNormalizado) ?? [];
    if (candidatas.length > 1) {
      candidatas.forEach((c) => usadas.add(c.id));
      salida.push({
        ...base,
        categoria: "VARIAS_EN_SISTEMA",
        detalle: `${fila.factura} está ${candidatas.length} veces en el sistema (${candidatas
          .map((c) => `${c.numFactura} en ${c.consecutivo}`)
          .join(", ")}): revisar el duplicado antes de conciliar.`,
        factura: null,
        saldo: null,
        diferenciaCentavos: null,
      });
      continue;
    }

    if (candidatas.length === 0) {
      const digitos = digitosSignificativos(fila.factura);
      const parecidas =
        digitos === ""
          ? []
          : e.facturas.filter(
              (f) =>
                !usadas.has(f.id) &&
                !numerosExcel.has(f.numeroNormalizado) &&
                digitosSignificativos(f.numFactura) === digitos,
            );
      if (parecidas.length > 0) {
        parecidas.forEach((c) => usadas.add(c.id));
        salida.push({
          ...base,
          categoria: "NUMERO_PARECIDO",
          detalle: `No hay ${fila.factura} exacta, pero sí ${parecidas
            .map((p) => `${p.numFactura} (${p.consecutivo})`)
            .join(", ")} con los mismos dígitos: revisar si es la misma.`,
          factura: parecidas.length === 1 ? parecidas[0] : null,
          saldo: parecidas.length === 1 ? saldoFactura(parecidas[0]) : null,
          diferenciaCentavos: null,
        });
        continue;
      }
      salida.push({
        ...base,
        categoria: "NO_EN_SISTEMA",
        detalle: tramiteExcel
          ? `No está en el sistema; el DO ${tramiteExcel.consecutivo} sí existe.`
          : ambiguo
            ? `No está en el sistema; el DO ${fila.doTexto} existe en más de una ciudad.`
            : `No está en el sistema y el DO ${fila.doTexto} tampoco.`,
        factura: null,
        saldo: null,
        diferenciaCentavos: null,
      });
      continue;
    }

    const f = candidatas[0];
    usadas.add(f.id);
    const saldo = saldoFactura(f);
    const diferenciaCentavos = fila.totalCentavos - f.valor * 100n;
    if (diferenciaCentavos !== 0n && diferenciaCentavos > -100n && diferenciaCentavos < 100n) notas.push("CENTAVOS");
    if (!marcaCoincide(fila.marca, f.marcaDo)) notas.push("MARCA_DISTINTA");
    const comun = { ...base, factura: f, saldo, diferenciaCentavos };

    if (fila.doAnio === null || fila.doNumero === null || f.doAnio !== fila.doAnio || f.doNumero !== fila.doNumero) {
      salida.push({
        ...comun,
        categoria: "DO_DISTINTO",
        detalle:
          fila.doAnio === null
            ? `El DO del Excel ("${fila.doTexto}") no se entiende; en el sistema está en ${f.consecutivo}.`
            : `El Excel la pone en el DO ${fila.doTexto}; el sistema, en ${f.consecutivo} (${doCorto(f.doAnio, f.doNumero)}).`,
      });
      continue;
    }
    if (diferenciaCentavos <= -100n || diferenciaCentavos >= 100n) {
      salida.push({
        ...comun,
        categoria: "VALOR_DISTINTO",
        detalle: `Excel ${formatoCentavosPesos(fila.totalCentavos)}; sistema ${formatoPesos(f.valor)} (diferencia ${formatoCentavosPesos(diferenciaCentavos)}).`,
      });
      continue;
    }

    const excelPagada = fila.pago !== null;
    if (excelPagada) {
      if (saldo === 0n) {
        salida.push({ ...comun, categoria: "PAGADA_OK", detalle: `Pagada en los dos (Excel: ${fechaCorta(fila.pago!)}).` });
        continue;
      }
      if (f.tramiteEstado === "CERRADO") {
        salida.push({
          ...comun,
          categoria: "DO_CERRADO",
          detalle: `El Excel dice pagada el ${fechaCorta(fila.pago!)}, pero ${f.consecutivo} está cerrado: un administrador debe reabrirlo para registrarlo.`,
        });
        continue;
      }
      const propuesta = buscarPagoPrevio(f, saldo, e.pagos, ignorar, prometido);
      if (propuesta) {
        prometido.set(propuesta.pagoId, (prometido.get(propuesta.pagoId) ?? 0n) + propuesta.monto);
        salida.push({
          ...comun,
          categoria: "PAGO_PREVIO_SIN_ENLAZAR",
          propuestaEnlace: propuesta,
          detalle: `${f.consecutivo} ya tiene el pago "${propuesta.concepto}" (${formatoPesos(propuesta.valor)}, sin aplicar ${formatoPesos(propuesta.disponible)}; ${propuesta.motivo}). Propuesta: enlazar ${formatoPesos(propuesta.monto)} de ese pago a ${f.numFactura} en vez de registrar otro pago.`,
        });
        continue;
      }
      if (saldo < f.valor) {
        salida.push({
          ...comun,
          categoria: "ABONADA_EN_SISTEMA",
          detalle: `El Excel dice pagada el ${fechaCorta(fila.pago!)}; en el sistema está Abonada (faltan ${formatoPesos(saldo)}). Revisar con el extracto.`,
        });
        continue;
      }
      salida.push({
        ...comun,
        categoria: "PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA",
        detalle: `Pagada el ${fechaCorta(fila.pago!)} según el Excel; en el sistema sigue Pendiente por ${formatoPesos(saldo)}.`,
      });
      continue;
    }

    if (saldo === 0n) {
      salida.push({
        ...comun,
        categoria: "PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL",
        detalle: `El sistema la tiene Pagada; en el Excel no tiene fecha de PAGO. Camila debe anotarla en el Excel.`,
      });
    } else if (saldo < f.valor) {
      salida.push({
        ...comun,
        categoria: "ABONADA_EN_SISTEMA",
        detalle: `Pendiente en el Excel; en el sistema está Abonada (faltan ${formatoPesos(saldo)}).`,
      });
    } else {
      salida.push({ ...comun, categoria: "PENDIENTE_EN_AMBOS", detalle: `Pendiente en los dos (${formatoPesos(saldo)}).` });
    }
  }

  for (const f of e.facturas) {
    if (usadas.has(f.id)) continue;
    salida.push({
      fila: null,
      categoria: "SOLO_EN_SISTEMA",
      notas: [],
      detalle: `${f.numFactura} (${f.consecutivo}) está en el sistema y no en el Excel; saldo ${formatoPesos(saldoFactura(f))}.`,
      factura: f,
      saldo: saldoFactura(f),
      tramiteExcel: null,
      diferenciaCentavos: null,
      propuestaEnlace: null,
    });
  }

  const conteo = Object.fromEntries(CATEGORIAS.map((c) => [c, 0])) as Record<CategoriaConciliacion, number>;
  for (const s of salida) conteo[s.categoria] += 1;

  // pagadoSinFactura por DO afectado.
  const afectados = new Map<string, string>();
  for (const s of salida) {
    if (
      s.factura &&
      (s.categoria === "PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA" || s.categoria === "PAGO_PREVIO_SIN_ENLAZAR")
    ) {
      afectados.set(s.factura.tramiteId, s.factura.consecutivo);
    }
  }
  const pagadoSinFacturaPorDo = [...afectados.entries()]
    .map(([tramiteId, consecutivo]) => ({
      tramiteId,
      consecutivo,
      monto: e.pagos
        .filter((p) => p.tramiteId === tramiteId && p.delProveedor && !ignorar.has(p.id))
        .reduce((acc, p) => acc + (p.valor > p.aplicado ? p.valor - p.aplicado : 0n), 0n),
    }))
    .sort((a, b) => a.consecutivo.localeCompare(b.consecutivo));

  return { nitBase: e.nitBase, nombreProveedor: e.nombreProveedor, filas: salida, conteo, pagadoSinFacturaPorDo };
}

/**
 * Pago del mismo DO con plata sin aplicar que puede ser el pago real de esta
 * factura: (1) a una ficha con el mismo NIT base, (2) que nombra el número en
 * concepto/soporte, o (3) sin ficha y con el nombre del proveedor en el concepto
 * lo decide quien llama. Primero los que nombran la factura, luego por fecha.
 */
function buscarPagoPrevio(
  f: FacturaSistema,
  saldo: bigint,
  pagos: readonly PagoSistema[],
  ignorar: ReadonlySet<string>,
  prometido: ReadonlyMap<string, bigint>,
): PropuestaEnlace | null {
  const opciones = pagos
    .filter((p) => p.tramiteId === f.tramiteId && !ignorar.has(p.id))
    .map((p) => {
      const nombra = textoNombraFactura(p.concepto, f.numFactura) || textoNombraFactura(p.numSoporte, f.numFactura);
      const disponible = p.valor - p.aplicado - (prometido.get(p.id) ?? 0n);
      return { p, nombra, disponible };
    })
    .filter((o) => o.disponible > 0n && (o.p.delProveedor || o.nombra))
    .sort(
      (a, b) =>
        Number(b.nombra) - Number(a.nombra) ||
        a.p.createdAt.getTime() - b.p.createdAt.getTime() ||
        a.p.id.localeCompare(b.p.id),
    );
  const o = opciones[0];
  if (!o) return null;
  const motivo = o.nombra
    ? "el concepto o el soporte nombra la factura"
    : "es un pago a una ficha del mismo proveedor";
  return {
    pagoId: o.p.id,
    concepto: o.p.concepto,
    valor: o.p.valor,
    disponible: o.disponible,
    monto: o.disponible < saldo ? o.disponible : saldo,
    motivo,
  };
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

export interface BloqueHistoricoPlan {
  nitBase: string;
  archivo: string;
  /** Fecha de la columna PAGO ("2026-04-23"). */
  fechaPago: string;
  beneficiarioId: string;
  concepto: string;
  claveIdempotencia: string;
  facturas: { facturaId: string; numFactura: string; tramiteId: string; consecutivo: string; monto: bigint }[];
  total: bigint;
}

export interface EnlacePlan {
  pagoId: string;
  concepto: string;
  valor: bigint;
  aplicaciones: { facturaId: string; numFactura: string; monto: bigint }[];
}

export interface ImportacionPlan {
  fila: FilaCartera;
  tramiteId: string;
  consecutivo: string;
  /** Pesos enteros: redondeo al peso más cercano (mitad hacia arriba); el exacto queda en el CSV. */
  valor: bigint;
}

export interface PlanConciliacion {
  bloques: BloqueHistoricoPlan[];
  enlaces: EnlacePlan[];
  importaciones: ImportacionPlan[];
}

/** UUID determinista (formato 8-4-4-4-12) a partir de sha256: misma entrada → misma clave. */
export function uuidDeterminista(texto: string): string {
  const h = createHash("sha256").update(texto).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Clave de idempotencia del bloque histórico: sha256(archivo | NIT | fecha | ids ordenados). */
export function claveBloqueHistorico(archivo: string, nitBase: string, fechaPago: string, facturaIds: string[]): string {
  return uuidDeterminista(["conciliacion-cxp-v2", archivo, nitBase, fechaPago, ...[...facturaIds].sort()].join("|"));
}

/** "2026-04-23" → "23/04/2026". */
export function fechaCorta(ymdTexto: string): string {
  const [y, m, d] = ymdTexto.split("-");
  return `${d}/${m}/${y}`;
}

/** Pesos redondeados al peso (mitad hacia arriba) desde centavos positivos. */
export function pesosDesdeCentavos(centavos: bigint): bigint {
  return (centavos + 50n) / 100n;
}

/**
 * Plan de escritura a partir de la clasificación:
 *  · bloques: candidatas (PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA) agrupadas por
 *    fecha PAGO → un bloque histórico por fecha, cada factura por su saldo.
 *  · enlaces: propuestas PAGO_PREVIO_SIN_ENLAZAR agrupadas por pago (solo se
 *    ejecutan las de `--enlazar-previos`).
 *  · importaciones (solo con `importarHistorico`): NO_EN_SISTEMA con DO único,
 *    no cerrado y sin pagos previos del proveedor pendientes de aplicar.
 */
export function planificarConciliacion(
  r: ResultadoClasificacion,
  opciones: { archivo: string; beneficiarioId: string; importarHistorico: boolean; pagos?: readonly PagoSistema[] },
): PlanConciliacion {
  const porFecha = new Map<string, BloqueHistoricoPlan["facturas"]>();
  for (const s of r.filas) {
    if (s.categoria !== "PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA" || !s.factura || !s.fila?.pago || !s.saldo) continue;
    const lista = porFecha.get(s.fila.pago) ?? [];
    lista.push({
      facturaId: s.factura.id,
      numFactura: s.factura.numFactura,
      tramiteId: s.factura.tramiteId,
      consecutivo: s.factura.consecutivo,
      monto: s.saldo,
    });
    porFecha.set(s.fila.pago, lista);
  }
  const bloques = [...porFecha.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fechaPago, facturas]) => {
      const ordenadas = [...facturas].sort(
        (a, b) => a.consecutivo.localeCompare(b.consecutivo) || a.numFactura.localeCompare(b.numFactura),
      );
      return {
        nitBase: r.nitBase,
        archivo: opciones.archivo,
        fechaPago,
        beneficiarioId: opciones.beneficiarioId,
        concepto: `Pago en bloque ${fechaCorta(fechaPago)} (registro histórico del Excel ${opciones.archivo})`,
        claveIdempotencia: claveBloqueHistorico(
          opciones.archivo,
          r.nitBase,
          fechaPago,
          ordenadas.map((f) => f.facturaId),
        ),
        facturas: ordenadas,
        total: ordenadas.reduce((acc, f) => acc + f.monto, 0n),
      };
    });

  const porPago = new Map<string, EnlacePlan>();
  for (const s of r.filas) {
    const p = s.propuestaEnlace;
    if (s.categoria !== "PAGO_PREVIO_SIN_ENLAZAR" || !p || !s.factura) continue;
    const e = porPago.get(p.pagoId) ?? { pagoId: p.pagoId, concepto: p.concepto, valor: p.valor, aplicaciones: [] };
    e.aplicaciones.push({ facturaId: s.factura.id, numFactura: s.factura.numFactura, monto: p.monto });
    porPago.set(p.pagoId, e);
  }

  const importaciones: ImportacionPlan[] = [];
  if (opciones.importarHistorico) {
    for (const s of r.filas) {
      if (s.categoria !== "NO_EN_SISTEMA" || !s.fila || !s.tramiteExcel) continue;
      if (s.tramiteExcel.estado === "CERRADO") continue;
      const conPrevio = (opciones.pagos ?? []).some(
        (p) => p.tramiteId === s.tramiteExcel!.id && p.delProveedor && p.valor > p.aplicado,
      );
      if (conPrevio) continue;
      importaciones.push({
        fila: s.fila,
        tramiteId: s.tramiteExcel.id,
        consecutivo: s.tramiteExcel.consecutivo,
        valor: pesosDesdeCentavos(s.fila.totalCentavos),
      });
    }
  }

  return { bloques, enlaces: [...porPago.values()], importaciones };
}

/**
 * ¿Queda alguna fila que el Excel da por pagada y el sistema todavía muestra
 * con saldo? Mientras quede, la cartera NO se marca conciliada (la franja
 * "Cartera sin conciliar" sigue y "Pagar en bloque" no preselecciona: así no
 * se paga dos veces algo que ya salió).
 */
export function filasPagadasEnExcelConSaldo(r: ResultadoClasificacion): FilaConciliada[] {
  return r.filas.filter(
    (s) => s.fila?.pago != null && s.factura !== null && s.saldo !== null && s.saldo > 0n && s.categoria !== "NO_EN_SISTEMA",
  );
}

// ─── Reportes ─────────────────────────────────────────────────────────────────

/** Centavos → "502801.45" (exacto, punto decimal: para el CSV y la fase de centavos). */
export function textoExactoCentavos(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

/** Centavos → "$502.801,45" (o "$99.484" si no hay centavos). */
export function formatoCentavosPesos(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const pesos = formatoPesos(a / 100n);
  const cent = a % 100n;
  return `${neg ? "−" : ""}${pesos}${cent === 0n ? "" : `,${String(cent).padStart(2, "0")}`}`;
}

const DESCRIPCION: Record<CategoriaConciliacion, string> = {
  PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA: "Pagada en el Excel, pendiente en el sistema (se registra como pago histórico)",
  PAGO_PREVIO_SIN_ENLAZAR: "El DO ya tiene un pago sin enlazar (NO se paga otra vez; se propone enlazar)",
  PAGADA_OK: "Pagada en los dos",
  PENDIENTE_EN_AMBOS: "Pendiente en los dos",
  PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL: "Pagada en el sistema, pendiente en el Excel",
  ABONADA_EN_SISTEMA: "Abonada en el sistema (revisar)",
  DO_CERRADO: "DO cerrado (hay que reabrirlo)",
  DO_DISTINTO: "DO distinto",
  VALOR_DISTINTO: "Valor distinto ($1 o más)",
  NUMERO_PARECIDO: "Número parecido (mismos dígitos)",
  VARIAS_EN_SISTEMA: "Repetida en el sistema",
  REPETIDA_EN_EXCEL: "Repetida en el Excel",
  NO_EN_SISTEMA: "No está en el sistema",
  SOLO_EN_SISTEMA: "Solo en el sistema (el Excel no la trae)",
};

export function descripcionCategoria(c: CategoriaConciliacion): string {
  return DESCRIPCION[c];
}

function accionDe(s: FilaConciliada, plan: PlanConciliacion): string {
  switch (s.categoria) {
    case "PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA": {
      const b = plan.bloques.find((x) => x.facturas.some((f) => f.facturaId === s.factura?.id));
      return b ? `pago histórico ${fechaCorta(b.fechaPago)} por ${formatoPesos(s.saldo ?? 0n)}` : "";
    }
    case "PAGO_PREVIO_SIN_ENLAZAR":
      return s.propuestaEnlace
        ? `enlazar el pago ${s.propuestaEnlace.pagoId} (${s.propuestaEnlace.concepto}, ${formatoPesos(s.propuestaEnlace.valor)}) por ${formatoPesos(s.propuestaEnlace.monto)}`
        : "";
    case "NO_EN_SISTEMA": {
      const imp = plan.importaciones.find((i) => i.fila === s.fila);
      return imp ? `importar a ${imp.consecutivo} por ${formatoPesos(imp.valor)}${imp.fila.pago ? " y pago histórico" : ""}` : "";
    }
    default:
      return "";
  }
}

function csvCampo(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const COLUMNAS_CSV = [
  "archivo",
  "fila",
  "nit_base",
  "factura_excel",
  "marca_excel",
  "do_excel",
  "fecha_excel",
  "total_excel_exacto",
  "pago_excel",
  "categoria",
  "notas",
  "factura_id",
  "factura_sistema",
  "do_sistema",
  "valor_sistema",
  "saldo_sistema",
  "diferencia_centavos",
  "accion",
  "detalle",
] as const;

/** Una línea por fila (con el TOTAL EXACTO del Excel: insumo de la fase de centavos, §F). */
export function filasCsv(r: ResultadoClasificacion, plan: PlanConciliacion): string[] {
  return r.filas.map((s) =>
    [
      s.fila?.archivo ?? "",
      s.fila ? String(s.fila.fila) : "",
      r.nitBase,
      s.fila?.factura ?? "",
      s.fila?.marca ?? "",
      s.fila?.doTexto ?? "",
      s.fila?.fecha ?? "",
      s.fila ? textoExactoCentavos(s.fila.totalCentavos) : "",
      s.fila?.pago ?? "",
      s.categoria,
      s.notas.join("|"),
      s.factura?.id ?? "",
      s.factura?.numFactura ?? "",
      s.factura?.consecutivo ?? s.tramiteExcel?.consecutivo ?? "",
      s.factura ? s.factura.valor.toString() : "",
      s.saldo !== null ? s.saldo.toString() : "",
      s.diferenciaCentavos !== null ? s.diferenciaCentavos.toString() : "",
      accionDe(s, plan),
      s.detalle,
    ]
      .map(csvCampo)
      .join(","),
  );
}

export function encabezadoCsv(): string {
  return COLUMNAS_CSV.join(",");
}

export interface ResumenEjecucion {
  bloques: { fechaPago: string; total: bigint; facturas: number; ok: boolean; grupoPagoId?: string; repetido?: boolean; error?: string }[];
  enlaces: { pagoId: string; ok: boolean; aplicado?: bigint; error?: string }[];
  importaciones: { factura: string; consecutivo: string; ok: boolean; facturaId?: string; error?: string }[];
  carteraMarcadaConciliada: boolean;
  motivoNoMarcada?: string;
}

export interface CifrasProveedor {
  pendiente: bigint;
  facturasConSaldo: number;
}

/** Sección Markdown de un proveedor (simulacro o aplicar), en español claro para Ernesto y Camila. */
export function reporteMarkdownProveedor(i: {
  modo: "simulacro" | "aplicar";
  archivo: string;
  antes: ResultadoClasificacion;
  plan: PlanConciliacion;
  erroresLectura: ErrorLectura[];
  cifrasAntes: CifrasProveedor | null;
  despues?: ResultadoClasificacion;
  cifrasDespues?: CifrasProveedor | null;
  ejecucion?: ResumenEjecucion;
  saldosDo?: { consecutivo: string; antes: bigint; despues: bigint | null }[];
}): string {
  const r = i.antes;
  const l: string[] = [];
  l.push(`## ${r.nombreProveedor} (NIT ${r.nitBase}) — ${i.archivo}`);
  l.push("");
  const filasExcel = r.filas.filter((s) => s.fila).length;
  l.push(`- Filas del Excel leídas: **${filasExcel}**${i.erroresLectura.length ? ` · filas que no se pudieron leer: **${i.erroresLectura.length}**` : ""}`);
  if (i.cifrasAntes) {
    l.push(`- Pendiente por pagar en el sistema ANTES: **${formatoPesos(i.cifrasAntes.pendiente)}** (${i.cifrasAntes.facturasConSaldo} factura(s) con saldo)`);
  }
  if (i.cifrasDespues) {
    l.push(`- Pendiente por pagar en el sistema DESPUÉS: **${formatoPesos(i.cifrasDespues.pendiente)}** (${i.cifrasDespues.facturasConSaldo} factura(s) con saldo)`);
  }
  l.push("");
  l.push("| Categoría | Filas | Qué significa |");
  l.push("|---|---:|---|");
  for (const c of CATEGORIAS) {
    if (r.conteo[c] === 0) continue;
    l.push(`| \`${c}\` | ${r.conteo[c]} | ${DESCRIPCION[c]} |`);
  }
  const conCentavos = r.filas.filter((s) => s.notas.includes("CENTAVOS")).length;
  if (conCentavos) l.push(`\nNota \`CENTAVOS\` (menos de $1 de diferencia, se acepta; el valor exacto queda en el CSV): **${conCentavos}** fila(s).`);

  l.push("");
  l.push(`### ${i.modo === "simulacro" ? "Pagos históricos que se registrarían" : "Pagos históricos registrados"}`);
  if (i.plan.bloques.length === 0) l.push("\nNinguno.");
  for (const b of i.plan.bloques) {
    const ej = i.ejecucion?.bloques.find((x) => x.fechaPago === b.fechaPago);
    const estado = ej ? (ej.ok ? (ej.repetido ? " — ya estaba registrado (repetido)" : ` — registrado (bloque ${ej.grupoPagoId})`) : ` — **FALLÓ: ${ej.error}**`) : "";
    l.push(`\n- **${fechaCorta(b.fechaPago)}** · ${formatoPesos(b.total)} · ${b.facturas.length} factura(s) · costo bancario $0 (lo asume Galcomex) · clave \`${b.claveIdempotencia}\`${estado}`);
    for (const f of b.facturas) l.push(`  - ${f.numFactura} · ${f.consecutivo} · ${formatoPesos(f.monto)}`);
  }

  const previos = r.filas.filter((s) => s.categoria === "PAGO_PREVIO_SIN_ENLAZAR");
  if (previos.length) {
    l.push("\n### Pagos previos sin enlazar (NO se registran; se enlazan solo con `--enlazar-previos <ids>`)");
    for (const s of previos) l.push(`- ${s.fila?.factura} · ${s.detalle}`);
    for (const e of i.ejecucion?.enlaces ?? []) {
      l.push(`- Enlace del pago ${e.pagoId}: ${e.ok ? `hecho (${formatoPesos(e.aplicado ?? 0n)} aplicados)` : `**FALLÓ: ${e.error}**`}`);
    }
  }

  if (r.pagadoSinFacturaPorDo.length) {
    l.push("\n### Pagado sin factura por DO afectado (pagos a este proveedor que no cubren ninguna factura)");
    for (const d of r.pagadoSinFacturaPorDo) l.push(`- ${d.consecutivo}: ${formatoPesos(d.monto)}`);
  }
  if (i.saldosDo?.length) {
    l.push("\n### Saldo de los DOs afectados (anticipos − pagos)");
    for (const d of i.saldosDo) l.push(`- ${d.consecutivo}: ${formatoPesos(d.antes)}${d.despues !== null ? ` → ${formatoPesos(d.despues)}` : ""}`);
  }

  const revisar: CategoriaConciliacion[] = [
    "DO_DISTINTO",
    "VALOR_DISTINTO",
    "ABONADA_EN_SISTEMA",
    "DO_CERRADO",
    "PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL",
    "NUMERO_PARECIDO",
    "VARIAS_EN_SISTEMA",
    "REPETIDA_EN_EXCEL",
    "SOLO_EN_SISTEMA",
  ];
  const aRevisar = r.filas.filter((s) => revisar.includes(s.categoria));
  if (aRevisar.length) {
    l.push("\n### Diferencias para revisar (no se tocan)");
    for (const s of aRevisar) l.push(`- \`${s.categoria}\` · ${s.fila ? `${s.fila.factura} (fila ${s.fila.fila})` : s.factura?.numFactura} · ${s.detalle}`);
  }

  const noEn = r.filas.filter((s) => s.categoria === "NO_EN_SISTEMA");
  if (noEn.length) {
    const conDo = noEn.filter((s) => s.tramiteExcel).length;
    l.push(`\n### No están en el sistema: ${noEn.length} fila(s)`);
    l.push(`- Con el DO en el sistema: ${conDo}. Sin el DO: ${noEn.length - conDo}. (Lista completa en el CSV.)`);
    if (i.plan.importaciones.length) {
      l.push(`- Con \`--importar-historico\` se crearían ${i.plan.importaciones.length} factura(s): ${i.plan.importaciones.map((m) => `${m.fila.factura} → ${m.consecutivo}`).join(", ")}.`);
    }
    for (const m of i.ejecucion?.importaciones ?? []) {
      l.push(`- Importación ${m.factura} → ${m.consecutivo}: ${m.ok ? "hecha" : `**FALLÓ: ${m.error}**`}`);
    }
  }

  if (i.erroresLectura.length) {
    l.push("\n### Filas del Excel que no se pudieron leer");
    for (const e of i.erroresLectura) l.push(`- Fila ${e.fila}: ${e.motivo}`);
  }

  if (i.despues) {
    l.push("\n### Después de aplicar");
    l.push(
      CATEGORIAS.filter((c) => i.despues!.conteo[c] > 0)
        .map((c) => `\`${c}\` ${i.despues!.conteo[c]}`)
        .join(" · "),
    );
  }
  if (i.ejecucion) {
    l.push(
      `\nCartera marcada como conciliada: **${i.ejecucion.carteraMarcadaConciliada ? "sí" : "no"}**${i.ejecucion.motivoNoMarcada ? ` (${i.ejecucion.motivoNoMarcada})` : ""}.`,
    );
  }
  l.push("");
  return l.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// CAPA DE BD
// ═════════════════════════════════════════════════════════════════════════════

type Db = PrismaClient;

export interface FichaConciliacion {
  id: string;
  nombre: string;
  nombreCorto: string | null;
  empresaId: string | null;
  conciliacionPendiente: boolean;
  carteraConciliadaEn: Date | null;
}

export interface DatosConciliacion {
  fichas: FichaConciliacion[];
  facturas: FacturaSistema[];
  pagos: PagoSistema[];
  tramites: TramiteSistema[];
}

function fechaIso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function marcaDe(doCliente: string | null, proveedorCliente: string | null): string | null {
  const partes = [doCliente, proveedorCliente].map((p) => p?.trim() ?? "").filter((p) => p !== "");
  return partes.length ? partes.join(" ") : null;
}

/**
 * Carga del sistema todo lo que la clasificación necesita para un NIT base:
 * fichas con ese NIT base, sus facturas (con Σ puente, Σ ajustes y cruce),
 * los DOs de importación que nombra el Excel y los pagos de todos esos DOs.
 */
export async function cargarDatosConciliacion(db: Db, nitBase: string, filas: FilaCartera[]): Promise<DatosConciliacion> {
  const fichas = await db.beneficiario.findMany({
    where: { nitBase },
    select: { id: true, nombre: true, nombreCorto: true, empresaId: true, conciliacionPendiente: true, carteraConciliadaEn: true },
    orderBy: { id: "asc" },
  });
  const fichaIds = fichas.map((f) => f.id);

  const facturasBd = await db.facturaProveedor.findMany({
    where: { OR: [{ beneficiarioId: { in: fichaIds } }, { proveedorClave: `NIT:${nitBase}` }] },
    select: {
      id: true,
      numFactura: true,
      numFacturaNormalizado: true,
      beneficiarioId: true,
      valor: true,
      montoCompensado: true,
      fecha: true,
      createdAt: true,
      tramite: {
        select: { id: true, consecutivo: true, anio: true, numero: true, estado: true, doCliente: true, proveedorCliente: true },
      },
    },
    orderBy: [{ fecha: "asc" }, { id: "asc" }],
  });
  const facturaIds = facturasBd.map((f) => f.id);
  const [puentes, ajustes] = await Promise.all([
    facturaIds.length
      ? db.pagoTramiteFactura.groupBy({ by: ["facturaId"], where: { facturaId: { in: facturaIds } }, _sum: { monto: true } })
      : Promise.resolve([]),
    facturaIds.length
      ? db.ajusteFacturaProveedor.groupBy({ by: ["facturaId"], where: { facturaId: { in: facturaIds } }, _sum: { monto: true } })
      : Promise.resolve([]),
  ]);
  const aplicadoPor = new Map(puentes.map((p) => [p.facturaId, p._sum.monto ?? 0n]));
  const ajustesPor = new Map(ajustes.map((a) => [a.facturaId, a._sum.monto ?? 0n]));

  const facturas: FacturaSistema[] = facturasBd.map((f) => ({
    id: f.id,
    numFactura: f.numFactura,
    numeroNormalizado: f.numFacturaNormalizado ?? normalizarNumeroFactura(f.numFactura),
    beneficiarioId: f.beneficiarioId,
    tramiteId: f.tramite.id,
    consecutivo: f.tramite.consecutivo,
    doAnio: f.tramite.anio,
    doNumero: f.tramite.numero,
    tramiteEstado: f.tramite.estado,
    marcaDo: f.tramite.proveedorCliente?.trim() || null,
    valor: f.valor,
    aplicado: aplicadoPor.get(f.id) ?? 0n,
    ajustes: ajustesPor.get(f.id) ?? 0n,
    compensado: f.montoCompensado,
    fecha: fechaIso(f.fecha) ?? "",
    createdAt: f.createdAt,
  }));

  const pares = [
    ...new Map(
      filas
        .filter((x) => x.doAnio !== null && x.doNumero !== null)
        .map((x) => [`${x.doAnio}-${x.doNumero}`, { anio: x.doAnio!, numero: x.doNumero! }]),
    ).values(),
  ];
  const tramitesBd = pares.length
    ? await db.tramiteDO.findMany({
        where: { tipoTramiteCodigo: "IMPORTACION", OR: pares },
        select: {
          id: true,
          consecutivo: true,
          ciudad: true,
          anio: true,
          numero: true,
          estado: true,
          doCliente: true,
          proveedorCliente: true,
        },
      })
    : [];
  const tramites: TramiteSistema[] = tramitesBd.map((t) => ({
    id: t.id,
    consecutivo: t.consecutivo,
    ciudad: t.ciudad,
    anio: t.anio,
    numero: t.numero,
    estado: t.estado,
    marca: marcaDe(t.doCliente, t.proveedorCliente),
  }));

  const tramiteIds = [...new Set([...facturas.map((f) => f.tramiteId), ...tramites.map((t) => t.id)])];
  const pagosBd = tramiteIds.length
    ? await db.pagoTramite.findMany({
        where: { tramiteId: { in: tramiteIds } },
        select: {
          id: true,
          tramiteId: true,
          concepto: true,
          numSoporte: true,
          valor: true,
          fechaRealPago: true,
          createdAt: true,
          beneficiarios: { select: { beneficiario: { select: { nitBase: true } } } },
          facturasProveedor: { select: { monto: true } },
        },
      })
    : [];
  const pagos: PagoSistema[] = pagosBd.map((p) => ({
    id: p.id,
    tramiteId: p.tramiteId,
    concepto: p.concepto,
    numSoporte: p.numSoporte,
    valor: p.valor,
    aplicado: p.facturasProveedor.reduce((acc, x) => acc + x.monto, 0n),
    delProveedor: p.beneficiarios.some((b) => b.beneficiario.nitBase === nitBase),
    sinBeneficiario: p.beneficiarios.length === 0,
    fechaRealPago: fechaIso(p.fechaRealPago),
    createdAt: p.createdAt,
  }));

  return { fichas, facturas, pagos, tramites };
}

/**
 * Pagos sin ficha cuyo concepto nombra al proveedor ("ALMACENAJE ALMACARGA …"):
 * se tratan como del proveedor para la detección de pagos previos (lado
 * seguro: a lo sumo mandan una fila a revisión, nunca crean un pago).
 */
export function marcarPagosSinFichaConNombre(pagos: PagoSistema[], nombres: readonly string[]): PagoSistema[] {
  const claves = nombres.map((n) => normalizarNumeroFactura(n)).filter((n) => n.length >= 4);
  return pagos.map((p) =>
    p.sinBeneficiario && !p.delProveedor && claves.some((c) => normalizarNumeroFactura(p.concepto).includes(c))
      ? { ...p, delProveedor: true }
      : p,
  );
}

/** Ficha que recibe los bloques históricos: la enlazada a la empresa primero; luego por id. */
export function fichaPrincipal(fichas: readonly FichaConciliacion[]): FichaConciliacion | null {
  const ordenadas = [...fichas].sort(
    (a, b) => Number(b.empresaId !== null) - Number(a.empresaId !== null) || a.id.localeCompare(b.id),
  );
  return ordenadas[0] ?? null;
}

export interface OpcionesConciliacion {
  archivo: string;
  filas: FilaCartera[];
  erroresLectura?: ErrorLectura[];
  nitBase: string;
  modo: "simulacro" | "aplicar";
  usuarioId: string;
  canal: CanalPago;
  /** Pagos previos que SÍ se enlazan (ids explícitos). */
  enlazarPrevios?: readonly string[];
  /** Pagos previos que un humano descartó: no son de este proveedor. */
  ignorarPrevios?: readonly string[];
  /** D-9 (A): crear las facturas NO_EN_SISTEMA cuyo DO existe (con este concepto). */
  importarHistorico?: { concepto: string } | null;
}

export interface InformeConciliacionProveedor {
  archivo: string;
  nitBase: string;
  nombreProveedor: string;
  modo: "simulacro" | "aplicar";
  antes: ResultadoClasificacion;
  plan: PlanConciliacion;
  cifrasAntes: CifrasProveedor | null;
  despues?: ResultadoClasificacion;
  cifrasDespues?: CifrasProveedor | null;
  ejecucion?: ResumenEjecucion;
  saldosDo: { consecutivo: string; antes: bigint; despues: bigint | null }[];
  erroresLectura: ErrorLectura[];
  /** Cambios escritos en BD (0 en simulacro y en una segunda corrida). */
  cambios: number;
  markdown: string;
  csv: string[];
}

export class ConciliacionUsuarioNoAdminError extends Error {
  constructor(email: string) {
    super(`La conciliación solo la puede ejecutar un ADMIN (${email} no lo es).`);
    this.name = "ConciliacionUsuarioNoAdminError";
  }
}

export class ConciliacionSinFichaError extends Error {
  constructor(nitBase: string) {
    super(`No hay ninguna ficha de pago con NIT base ${nitBase}: créala antes de conciliar.`);
    this.name = "ConciliacionSinFichaError";
  }
}

async function cifrasDe(db: Db, fichaId: string): Promise<CifrasProveedor | null> {
  const r = await resumenPorProveedor({ beneficiarioId: fichaId }, db);
  if (!r) return null;
  return { pendiente: r.resumen.pendiente, facturasConSaldo: r.facturasConSaldo };
}

function mensajeDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function clasificarDesdeBd(
  db: Db,
  o: OpcionesConciliacion,
): Promise<{ datos: DatosConciliacion; r: ResultadoClasificacion; ficha: FichaConciliacion }> {
  const datos = await cargarDatosConciliacion(db, o.nitBase, o.filas);
  const ficha = fichaPrincipal(datos.fichas);
  if (!ficha) throw new ConciliacionSinFichaError(o.nitBase);
  const nombres = [...new Set(datos.fichas.flatMap((f) => [f.nombreCorto ?? ""]).filter((n) => n))];
  const pagos = marcarPagosSinFichaConNombre(datos.pagos, nombres);
  const r = clasificarCartera({
    nitBase: o.nitBase,
    nombreProveedor: ficha.nombreCorto ?? ficha.nombre,
    filas: o.filas,
    facturas: datos.facturas,
    pagos,
    tramites: datos.tramites,
    ignorarPagos: new Set(o.ignorarPrevios ?? []),
  });
  return { datos: { ...datos, pagos }, r, ficha };
}

/**
 * Concilia un archivo contra un NIT base. En "simulacro" no escribe nada.
 * En "aplicar" (quien llama ya exigió `--aplicar` explícito):
 *   1. (opcional) importa las NO_EN_SISTEMA con DO (D-9 A);
 *   2. enlaza SOLO los pagos previos pedidos por id;
 *   3. vuelve a leer y registra un bloque histórico por fecha de PAGO
 *      (`crearPagoMultiDO` histórico: costo 0, GALCOMEX, clave determinista);
 *      una transacción por bloque, si una falla las demás siguen;
 *   4. sin errores y sin filas "pagada en el Excel con saldo en el sistema",
 *      marca las fichas del NIT como conciliadas (una sola vez).
 */
export async function conciliarProveedor(o: OpcionesConciliacion, db: Db = prismaGlobal): Promise<InformeConciliacionProveedor> {
  const usuario = await db.user.findUnique({ where: { id: o.usuarioId }, select: { email: true, rol: true } });
  if (!usuario || usuario.rol !== "ADMIN") throw new ConciliacionUsuarioNoAdminError(usuario?.email ?? o.usuarioId);

  const primera = await clasificarDesdeBd(db, o);
  const { ficha } = primera;
  const antes = primera.r;
  const plan = planificarConciliacion(antes, {
    archivo: o.archivo,
    beneficiarioId: ficha.id,
    importarHistorico: Boolean(o.importarHistorico),
    pagos: primera.datos.pagos,
  });
  const cifrasAntes = await cifrasDe(db, ficha.id);
  const dosAfectados = [
    ...new Set([
      ...plan.bloques.flatMap((b) => b.facturas.map((f) => f.tramiteId)),
      ...plan.enlaces.flatMap((e) =>
        e.aplicaciones.map((a) => primera.datos.facturas.find((f) => f.id === a.facturaId)?.tramiteId ?? ""),
      ),
      ...plan.importaciones.map((m) => m.tramiteId),
    ]),
  ].filter((x) => x);
  const contextoAntes = await cargarContextoDos(db, dosAfectados);
  const erroresLectura = o.erroresLectura ?? [];

  if (o.modo === "simulacro") {
    // Saldo del cliente (como `saldoTramite` y el libro): lo que se paga por
    // facturas NO SE COBRA (asesoría) no le baja el saldo.
    const facturasDeBloques = plan.bloques.flatMap((b) => b.facturas);
    const noSeCobran = new Set(
      facturasDeBloques.length === 0
        ? []
        : (
            await db.facturaProveedor.findMany({
              where: { id: { in: facturasDeBloques.map((f) => f.facturaId) }, repercutible: false },
              select: { id: true },
            })
          ).map((f) => f.id),
    );
    const saldosDo = [...contextoAntes.values()]
      .map((c) => {
        const baja =
          facturasDeBloques
            .filter((f) => f.tramiteId === c.tramiteId && !noSeCobran.has(f.facturaId))
            .reduce((a, f) => a + f.monto, 0n) +
          plan.importaciones.filter((m) => m.tramiteId === c.tramiteId && m.fila.pago).reduce((a, m) => a + m.valor, 0n);
        return { consecutivo: c.consecutivo, antes: c.saldoTramite, despues: c.saldoTramite - baja };
      })
      .sort((a, b) => a.consecutivo.localeCompare(b.consecutivo));
    const markdown = reporteMarkdownProveedor({ modo: "simulacro", archivo: o.archivo, antes, plan, erroresLectura, cifrasAntes, saldosDo });
    return {
      archivo: o.archivo,
      nitBase: o.nitBase,
      nombreProveedor: antes.nombreProveedor,
      modo: "simulacro",
      antes,
      plan,
      cifrasAntes,
      saldosDo,
      erroresLectura,
      cambios: 0,
      markdown,
      csv: filasCsv(antes, plan),
    };
  }

  // ─── APLICAR ───
  const ejecucion: ResumenEjecucion = { bloques: [], enlaces: [], importaciones: [], carteraMarcadaConciliada: false };
  let cambios = 0;

  // 1. Importación histórica (D-9 A): solo crea facturas; los pagos van en los bloques.
  for (const m of plan.importaciones) {
    try {
      const f = await crearFacturaProveedor({
        tramiteId: m.tramiteId,
        beneficiarioId: ficha.id,
        numFactura: m.fila.factura,
        valor: m.valor,
        fecha: new Date(`${m.fila.fecha ?? m.fila.pago ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
        concepto: o.importarHistorico!.concepto,
        repercutible: true,
        subidaPorId: o.usuarioId,
      });
      ejecucion.importaciones.push({ factura: m.fila.factura, consecutivo: m.consecutivo, ok: true, facturaId: f.id });
      cambios += 1;
    } catch (e) {
      ejecucion.importaciones.push({ factura: m.fila.factura, consecutivo: m.consecutivo, ok: false, error: mensajeDe(e) });
    }
  }

  // 2. Enlaces de pagos previos pedidos EXPLÍCITAMENTE por id.
  const pedidos = new Set(o.enlazarPrevios ?? []);
  for (const e of plan.enlaces) {
    if (!pedidos.has(e.pagoId)) continue;
    try {
      const r = await enlazarPagoExistente({
        pagoId: e.pagoId,
        aplicaciones: e.aplicaciones.map((a) => ({ facturaProveedorId: a.facturaId, monto: a.monto })),
        usuarioId: o.usuarioId,
      });
      ejecucion.enlaces.push({ pagoId: e.pagoId, ok: true, aplicado: r.aplicado });
      cambios += 1;
    } catch (err) {
      ejecucion.enlaces.push({ pagoId: e.pagoId, ok: false, error: mensajeDe(err) });
    }
  }
  for (const id of pedidos) {
    if (!plan.enlaces.some((e) => e.pagoId === id)) {
      ejecucion.enlaces.push({ pagoId: id, ok: false, error: "Ese pago no aparece como pago previo sin enlazar de este proveedor." });
    }
  }

  // 3. Releer (las importaciones y los enlaces cambian las candidatas) y registrar bloques.
  const segunda = await clasificarDesdeBd(db, o);
  const planBloques = planificarConciliacion(segunda.r, {
    archivo: o.archivo,
    beneficiarioId: ficha.id,
    importarHistorico: false,
  });
  for (const b of planBloques.bloques) {
    try {
      const r = await crearPagoMultiDO({
        beneficiarioId: b.beneficiarioId,
        facturas: b.facturas.map((f) => ({ facturaProveedorId: f.facturaId, monto: f.monto })),
        canalPago: o.canal,
        fechaRealPago: new Date(`${b.fechaPago}T00:00:00.000Z`),
        concepto: b.concepto,
        esHistorico: true,
        costoAsumidoPor: "GALCOMEX",
        claveIdempotencia: b.claveIdempotencia,
        usuarioId: o.usuarioId,
      });
      ejecucion.bloques.push({
        fechaPago: b.fechaPago,
        total: b.total,
        facturas: b.facturas.length,
        ok: true,
        grupoPagoId: r.grupoPagoId,
        repetido: r.repetido,
      });
      if (!r.repetido) cambios += 1;
    } catch (e) {
      ejecucion.bloques.push({ fechaPago: b.fechaPago, total: b.total, facturas: b.facturas.length, ok: false, error: mensajeDe(e) });
    }
  }

  // 4. Estado final y marca de cartera conciliada.
  const final = await clasificarDesdeBd(db, o);
  const despues = final.r;
  const huboErrores =
    ejecucion.bloques.some((b) => !b.ok) || ejecucion.enlaces.some((e) => !e.ok) || ejecucion.importaciones.some((m) => !m.ok);
  const pendientesExcel = filasPagadasEnExcelConSaldo(despues);
  if (huboErrores) {
    ejecucion.motivoNoMarcada = "hubo errores al aplicar";
  } else if (pendientesExcel.length > 0) {
    ejecucion.motivoNoMarcada = `quedan ${pendientesExcel.length} factura(s) que el Excel da por pagadas y el sistema muestra con saldo (${pendientesExcel
      .map((s) => `${s.fila?.factura}: ${s.categoria}`)
      .join(", ")})`;
  } else {
    const porMarcar = final.datos.fichas.filter((f) => f.conciliacionPendiente).map((f) => f.id);
    if (porMarcar.length) {
      await db.$transaction(async (tx) => {
        const ahora = new Date();
        await tx.beneficiario.updateMany({
          where: { id: { in: porMarcar }, conciliacionPendiente: true },
          data: { conciliacionPendiente: false, carteraConciliadaEn: ahora },
        });
        for (const id of porMarcar) {
          await tx.auditLog.create({
            data: {
              entidad: "Beneficiario",
              entidadId: id,
              accion: "CONCILIAR_CARTERA",
              usuarioId: o.usuarioId,
              antes: { conciliacionPendiente: true } satisfies Prisma.InputJsonValue,
              despues: {
                conciliacionPendiente: false,
                carteraConciliadaEn: ahora.toISOString(),
                archivo: o.archivo,
                nitBase: o.nitBase,
                bloques: ejecucion.bloques.map((b) => ({ fecha: b.fechaPago, grupoPagoId: b.grupoPagoId ?? null, total: b.total.toString() })),
              } satisfies Prisma.InputJsonValue,
            },
          });
        }
      });
      cambios += porMarcar.length;
    }
    ejecucion.carteraMarcadaConciliada = true;
  }

  const cifrasDespues = await cifrasDe(db, ficha.id);
  const contextoDespues = await cargarContextoDos(db, dosAfectados);
  const saldosDo = [...contextoAntes.values()]
    .map((c) => ({ consecutivo: c.consecutivo, antes: c.saldoTramite, despues: contextoDespues.get(c.tramiteId)?.saldoTramite ?? null }))
    .sort((a, b) => a.consecutivo.localeCompare(b.consecutivo));

  const planReportado: PlanConciliacion = { ...plan, bloques: planBloques.bloques };
  const markdown = reporteMarkdownProveedor({
    modo: "aplicar",
    archivo: o.archivo,
    antes,
    plan: planReportado,
    erroresLectura,
    cifrasAntes,
    despues,
    cifrasDespues,
    ejecucion,
    saldosDo,
  });
  return {
    archivo: o.archivo,
    nitBase: o.nitBase,
    nombreProveedor: antes.nombreProveedor,
    modo: "aplicar",
    antes,
    plan: planReportado,
    cifrasAntes,
    despues,
    cifrasDespues,
    ejecucion,
    saldosDo,
    erroresLectura,
    cambios,
    markdown,
    csv: filasCsv(despues, planReportado),
  };
}
