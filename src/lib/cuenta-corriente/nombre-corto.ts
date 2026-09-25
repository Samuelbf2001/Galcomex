/**
 * Nombre corto de una empresa para la UI de cuenta corriente ("Registrar
 * factura de <CORTO>"): quita el prefijo genérico del tipo de empresa y los
 * sufijos societarios/de nivel, comillas y paréntesis, para que quede el
 * nombre que la gente de verdad usa ("COLDEX", no "AGENCIA DE ADUANAS COLDEX
 * S.A.S NIVEL DOS"). Función pura, sin BD.
 *
 * Si al quitar todo no queda nada, devuelve el nombre original: mejor un
 * nombre largo que un botón vacío.
 */

const PREFIJOS_GENERICOS = [/^AGENCIA\s+DE\s+ADUANAS\s+/i, /^ALMACENADORA\s+DE\s+CARGA\s+/i];

const SUFIJOS_SOCIETARIOS = [
  /\s+S\.?A\.?S\.?$/i, // S.A.S, S.A.S., SAS
  /\s+S\.?A\.?$/i, // S.A., SA
  /\s+LTDA\.?$/i,
  /\s+NIVEL\s+(DOS|UNO|1|2)$/i,
];

export function nombreCortoEmpresa(nombre: string): string {
  const original = nombre;
  let resultado = nombre.trim();

  for (const prefijo of PREFIJOS_GENERICOS) {
    resultado = resultado.replace(prefijo, "");
  }

  // Los sufijos pueden venir combinados ("… S.A.S NIVEL DOS"): se repite
  // hasta que ninguno aplique más.
  let cambiado = true;
  while (cambiado) {
    cambiado = false;
    for (const sufijo of SUFIJOS_SOCIETARIOS) {
      const siguiente = resultado.replace(sufijo, "");
      if (siguiente !== resultado) {
        resultado = siguiente;
        cambiado = true;
      }
    }
  }

  resultado = resultado.replace(/["'()]/g, "").trim();

  return resultado || original;
}
