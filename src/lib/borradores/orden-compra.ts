/**
 * Orden de compra del cliente vs. factura (B4, Diseño B, 29-sep-2026) —
 * función PURA, sin BD (se importa también desde componentes cliente).
 *
 * Camila (nota de voz 3, 27-sep): «lo que se les cobra a ellos en la factura
 * debe coincidir con el mismo valor de la orden de compra que ellos mandan».
 * 4 facturas de Polyrec ZF se anularon y reemitieron en 2026 por no cumplirlo
 * (0012, 0130, 0135, 0196) porque la comparación vivía solo en el navegador y
 * `transicionarBorrador` aprobaba sin mirarla.
 *
 * Regla estándar (configurable por empresa en la capacidad
 * `orden_compra_en_revision`, sin programar): la base de la OC es
 * SERVICIO + REEMBOLSOS (terceros), SIN IVA, SIN ReteIVA y SIN 4x1000 — es lo
 * que muestran las OC reales (OC10944 = 1.901.939 incluye el pago a la VUCE de
 * DO.26-0079 y no su 4x1000 de 335). `base: "SOLO_SERVICIO"` y
 * `incluye4x1000: true` cubren las otras lecturas posibles. Tolerancia 0.
 *
 * Todo el dinero es BigInt (COP); nunca se pasa por `Number`.
 */

import { z } from "zod";

import { formatoPesos } from "@/lib/cxp/saldos";

/** Largo mínimo del motivo con el que la ADMIN aprueba una factura que no cuadra con la OC (mismo mínimo en el Zod del PATCH). */
export const MOTIVO_EXCEPCION_OC_MIN = 10;

// ─── Configuración ────────────────────────────────────────────────────────────

export type ConfigOrdenCompra = {
  /** Qué suma contra la OC: servicio + reembolsos (terceros) o solo el servicio de Galcomex. */
  base: "SERVICIO_Y_TERCEROS" | "SOLO_SERVICIO";
  /** ¿Entra el 4x1000 de los terceros en la base? (por defecto no: las OC reales no lo incluyen). */
  incluye4x1000: boolean;
  /** Si no cuadra (o falta el valor), ¿se frena la aprobación? Solo la ADMIN la salta, con motivo. */
  bloqueaAprobacion: boolean;
};

export const CONFIG_OC_DEFECTO: ConfigOrdenCompra = {
  base: "SERVICIO_Y_TERCEROS",
  incluye4x1000: false,
  bloqueaAprobacion: true,
};

const configOcSchema = z.object({
  base: z.enum(["SERVICIO_Y_TERCEROS", "SOLO_SERVICIO"]).default(CONFIG_OC_DEFECTO.base),
  incluye4x1000: z.boolean().default(CONFIG_OC_DEFECTO.incluye4x1000),
  bloqueaAprobacion: z.boolean().default(CONFIG_OC_DEFECTO.bloqueaAprobacion),
});

/**
 * Config efectiva de la capacidad. Cualquier cosa que no sea una config válida
 * (null, texto, un valor fuera de rango) cae a la de defecto COMPLETA: una
 * config rota nunca debe apagar el freno en silencio.
 */
export function configOrdenCompraDe(raw: unknown): ConfigOrdenCompra {
  const parsed = configOcSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...CONFIG_OC_DEFECTO };
}

// ─── Desglose de la factura para la OC ────────────────────────────────────────

export type LineaParaOc = {
  valor: bigint;
  seccion: "TERCEROS" | "OPERACIONAL";
  /** "IMPUESTO_4X1000" | "IVA_COMISION" | … | null. */
  tipoFija: string | null;
};

export type DesgloseOc = { servicio: bigint; terceros: bigint; cuatroXMil: bigint };

/**
 * Suma de lo que entra a la OC, con el MISMO filtro que
 * `sincronizarLineasDerivadas` (`formato-conceptos.ts`): servicio = líneas
 * OPERACIONAL sin `tipoFija`; terceros = TERCEROS sin `tipoFija`; el 4x1000 es
 * la línea fija IMPUESTO_4X1000. El IVA y la ReteIVA nunca entran.
 */
export function desgloseParaOc(lineas: readonly LineaParaOc[]): DesgloseOc {
  let servicio = 0n;
  let terceros = 0n;
  let cuatroXMil = 0n;
  for (const l of lineas) {
    if (l.tipoFija === "IMPUESTO_4X1000") {
      cuatroXMil += l.valor;
    } else if (l.tipoFija) {
      continue;
    } else if (l.seccion === "OPERACIONAL") {
      servicio += l.valor;
    } else {
      terceros += l.valor;
    }
  }
  return { servicio, terceros, cuatroXMil };
}

/**
 * Lo que la OC debe decir según la config: servicio (+ terceros) (+ 4x1000).
 * ÚNICA fuente de la regla: la usan el freno (`evaluarOrdenCompra`) y el «valor
 * para su orden de compra» de la cotización (B7, `cotizacion/calculo.ts`).
 */
export function baseParaOc(desglose: DesgloseOc, config: Pick<ConfigOrdenCompra, "base" | "incluye4x1000">): bigint {
  return (
    desglose.servicio +
    (config.base === "SERVICIO_Y_TERCEROS" ? desglose.terceros : 0n) +
    (config.incluye4x1000 ? desglose.cuatroXMil : 0n)
  );
}

// ─── Evaluación ───────────────────────────────────────────────────────────────

export type EvaluacionOc =
  | { estado: "SIN_OC" }
  | { estado: "SIN_VALOR"; numero: string }
  | {
      estado: "CUADRA" | "NO_CUADRA";
      numero: string;
      /** Valor de la OC de ESTE DO (su parte, si la OC se comparte). */
      valorOc: bigint;
      /** Lo que la factura suma contra la OC, según la config. */
      base: bigint;
      /** `base − valorOc`: negativo = faltan; positivo = sobran. */
      diferencia: bigint;
      desglose: DesgloseOc;
      config: ConfigOrdenCompra;
    };

export function evaluarOrdenCompra(i: {
  numero: string | null;
  valorOc: bigint | null;
  desglose: DesgloseOc;
  config: ConfigOrdenCompra;
}): EvaluacionOc {
  const numero = i.numero?.trim() ?? "";
  if (numero === "") return { estado: "SIN_OC" };
  if (i.valorOc === null) return { estado: "SIN_VALOR", numero };

  const { desglose, config } = i;
  const base = baseParaOc(desglose, config);
  const diferencia = base - i.valorOc;

  return {
    estado: diferencia === 0n ? "CUADRA" : "NO_CUADRA",
    numero,
    valorOc: i.valorOc,
    base,
    diferencia,
    desglose,
    config,
  };
}

// ─── Mensajes (lenguaje de negocio, en pesos) ─────────────────────────────────

/** Qué entra en la base, para explicarlo junto al resultado. */
export function explicacionBaseOc(config: ConfigOrdenCompra): string {
  const partes = config.base === "SERVICIO_Y_TERCEROS" ? "servicio + reembolsos" : "solo el servicio";
  return `${partes}, sin IVA ni ReteIVA${config.incluye4x1000 ? ", con el 4x1000" : " ni 4x1000"}`;
}

/**
 * Mensaje de un freno (`NO_CUADRA` o `SIN_VALOR`); null si no hay nada que
 * decir. Ej.: «La factura suma $427.000 sin impuestos y la orden de compra
 * OC11104 es de $539.000: faltan $112.000. Corrígela, devuélvela o pide una OC
 * nueva.»
 */
export function mensajeFrenoOc(ev: EvaluacionOc): string | null {
  if (ev.estado === "SIN_VALOR") {
    return `El DO tiene la orden de compra ${ev.numero} sin valor: escribe su valor en el DO o quita el número.`;
  }
  if (ev.estado !== "NO_CUADRA") return null;
  const dif = ev.diferencia < 0n ? -ev.diferencia : ev.diferencia;
  const sentido = ev.diferencia < 0n ? "faltan" : "sobran";
  return `La factura suma ${formatoPesos(ev.base)} sin impuestos y la orden de compra ${ev.numero} es de ${formatoPesos(ev.valorOc)}: ${sentido} ${formatoPesos(dif)}. Corrígela, devuélvela o pide una OC nueva.`;
}
