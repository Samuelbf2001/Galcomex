import { randomInt } from "node:crypto";

/**
 * Letras y números sin los que se confunden al dictarlos o copiarlos a mano:
 * sin 0/O/o, 1/l/I/i. 55 símbolos.
 */
export const ALFABETO_CLAVE_TEMPORAL =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

const GRUPOS = 3;
const POR_GRUPO = 4;

/**
 * Clave temporal legible de 14 caracteres (`Xk7m-Pq3r-Ht9w`): 12 símbolos
 * aleatorios (≈ 69 bits, `crypto.randomInt` sin sesgo) en tres grupos
 * separados por guion para dictarla sin errores. Cumple el mínimo de 10.
 */
export function generarClaveTemporal(): string {
  const grupos: string[] = [];
  for (let g = 0; g < GRUPOS; g++) {
    let grupo = "";
    for (let i = 0; i < POR_GRUPO; i++) {
      grupo += ALFABETO_CLAVE_TEMPORAL[randomInt(ALFABETO_CLAVE_TEMPORAL.length)];
    }
    grupos.push(grupo);
  }
  return grupos.join("-");
}
