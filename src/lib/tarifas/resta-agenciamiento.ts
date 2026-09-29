/**
 * B1 (Diseño A, 27-sep-2026) — "restar el agenciamiento de la agencia de
 * aduanas del DO" en un ítem del tarifario.
 *
 * Función PURA, sin BD, sin unidades de texto (`motor.ts` arma el `detalle`
 * con `formatoCOP`). Reglas (ver `simulacion-camila-27sep/DISENO-A.md` §1.3):
 *
 *   - Sin agencia en el DO           → `SIN_AGENCIA` (nunca cobra de más).
 *   - Agencia sin valor estándar     → `AGENCIA_SIN_VALOR`.
 *   - Ítem PORCENTAJE_MIN (`porcentaje` viene informado):
 *       NETO  (minimoEsDelTotal=false): neto = máx(porcentaje − agencia, mínimo).
 *             El mínimo es lo que cobra Galcomex.
 *       TOTAL (minimoEsDelTotal=true):  bruto = máx(porcentaje, mínimo);
 *             neto = bruto − agencia. El mínimo es lo que paga el cliente en total.
 *   - Cualquier otro tipo de cálculo: neto = valorCalculado − agencia.
 *   - `neto ≤ 0` → `NO_ALCANZA` (nunca una línea negativa ni un cero silencioso).
 *   - Un agenciamiento de `0` es un valor válido (no dispara `AGENCIA_SIN_VALOR`).
 */

export type ResultadoResta =
  | { ok: true; neto: bigint; bruto: bigint; minimoAplicado: "NETO" | "TOTAL" | null }
  | { ok: false; motivo: "SIN_AGENCIA" | "AGENCIA_SIN_VALOR" | "NO_ALCANZA"; bruto: bigint };

export function restarAgenciamiento(a: {
  /** Lo que da el ítem hoy (con mínimo ya aplicado si es PORCENTAJE_MIN). */
  valorCalculado: bigint;
  /** PORCENTAJE_MIN: % × CIF, sin mínimo. Ausente en cualquier otro tipo de cálculo. */
  porcentaje?: bigint;
  /** PORCENTAJE_MIN: mínimo del tipo de carga, o null si no hay mínimos configurados. */
  minimo?: bigint | null;
  minimoEsDelTotal: boolean;
  agencia: string | null;
  agenciamiento: bigint | null;
}): ResultadoResta {
  if (a.agencia === null) {
    return { ok: false, motivo: "SIN_AGENCIA", bruto: a.valorCalculado };
  }
  if (a.agenciamiento === null) {
    return { ok: false, motivo: "AGENCIA_SIN_VALOR", bruto: a.valorCalculado };
  }

  const agenciamiento = a.agenciamiento;

  if (a.porcentaje !== undefined) {
    const minimo = a.minimo ?? null;

    if (a.minimoEsDelTotal) {
      // TOTAL: el mínimo es lo que paga el cliente en total, ANTES de restar.
      const aplicaMinimo = minimo !== null && a.porcentaje < minimo;
      const bruto = aplicaMinimo ? minimo : a.porcentaje;
      const neto = bruto - agenciamiento;
      if (neto <= 0n) return { ok: false, motivo: "NO_ALCANZA", bruto };
      return { ok: true, neto, bruto, minimoAplicado: aplicaMinimo ? "TOTAL" : null };
    }

    // NETO: el mínimo es lo que cobra Galcomex, DESPUÉS de restar.
    const netoSinMinimo = a.porcentaje - agenciamiento;
    const aplicaMinimo = minimo !== null && netoSinMinimo < minimo;
    const neto = aplicaMinimo ? minimo : netoSinMinimo;
    const bruto = a.porcentaje;
    if (neto <= 0n) return { ok: false, motivo: "NO_ALCANZA", bruto };
    return { ok: true, neto, bruto, minimoAplicado: aplicaMinimo ? "NETO" : null };
  }

  // Cualquier otro tipo de cálculo (FIJO, POR_UNIDAD, POR_TRAMO,
  // PRIMERO_MAS_ADICIONAL, EVENTO con cantidad): resta directa.
  const neto = a.valorCalculado - agenciamiento;
  const bruto = a.valorCalculado;
  if (neto <= 0n) return { ok: false, motivo: "NO_ALCANZA", bruto };
  return { ok: true, neto, bruto, minimoAplicado: null };
}
