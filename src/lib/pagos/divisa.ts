/**
 * Reglas de dominio para los campos de divisa de un pago (TRM realmente
 * pagada) — reunión 1-jul-2026 (00:20–00:30, 01:25): el proveedor factura en
 * USD pero lo que se contabiliza es el COP realmente pagado. `valor` (COP)
 * SIEMPRE es la fuente de verdad contable y es obligatorio siempre; estos tres
 * campos solo documentan de dónde salió ese COP — nunca se usan para derivar
 * `valor`.
 *
 * Regla: o los tres campos vienen null/undefined, o los tres vienen
 * presentes. Nunca parcial. Función PURA, sin BD — usada por Zod y por el
 * servicio (defensa en profundidad: Zod valida el payload crudo de un POST,
 * el servicio valida el estado resultante tras fusionar un PATCH parcial con
 * lo que ya existe en BD).
 */
export type CamposDivisaInput = {
  moneda?: string | null;
  valorDivisa?: bigint | null;
  tasaCambio?: string | null;
};

function presente(v: string | bigint | null | undefined): boolean {
  return v !== undefined && v !== null;
}

/** true si los tres campos están completos (ninguno null/undefined). */
export function camposDivisaCompletos(input: CamposDivisaInput): boolean {
  return presente(input.moneda) && presente(input.valorDivisa) && presente(input.tasaCambio);
}

/** true si los tres campos están ausentes (todos null o undefined). */
export function camposDivisaAusentes(input: CamposDivisaInput): boolean {
  return !presente(input.moneda) && !presente(input.valorDivisa) && !presente(input.tasaCambio);
}

/** true si respeta la regla todo-o-nada (completos o los tres ausentes). */
export function camposDivisaValidos(input: CamposDivisaInput): boolean {
  return camposDivisaCompletos(input) || camposDivisaAusentes(input);
}

/** Un decimal simple en string: "4200", "4200.5", "4200.53". Sin exponentes ni separadores de miles. */
export function esDecimalValido(valor: string): boolean {
  return /^\d+(\.\d+)?$/.test(valor.trim());
}
