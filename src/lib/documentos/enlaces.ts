/**
 * Enlaces compartibles de documento.
 *
 * En la demo del 1-jul (min 01:29) se ofreció "descargar, compartir o en un
 * enlace público". Un enlace público permanente contradice la regla del
 * proyecto de que toda URL de storage caduca en ≤15 minutos, así que lo que se
 * comparte NO es el archivo sino un token propio: al abrirlo se valida vigencia
 * y revocación, y recién entonces se emite una URL prefirmada corta.
 *
 * El resultado es lo que Guillermo pedía —mandarle un soporte al cliente sin
 * que tenga que entrar al sistema— pero acotado: caduca solo, se revoca cuando
 * se quiera, cuenta cuántas veces se abrió y sabe quién lo creó.
 */

import { randomBytes } from "node:crypto";

/** Vigencia por defecto de un enlace compartido. */
export const ENLACE_VIGENCIA_DIAS_DEFAULT = 7;

/** Vigencia máxima admitida: más allá de esto deja de ser "temporal". */
export const ENLACE_VIGENCIA_DIAS_MAX = 30;

export type EstadoEnlace = "VIGENTE" | "EXPIRADO" | "REVOCADO";

export type EnlaceEvaluable = {
  expiresAt: Date;
  revocadoEn: Date | null;
};

/**
 * Estado de un enlace en un instante dado. Función PURA — sin BD ni reloj
 * implícito, para poder probar los bordes sin esperar.
 *
 * La revocación gana sobre la expiración: si alguien revocó un enlace, eso es
 * lo que hay que reportar aunque además ya hubiera caducado.
 */
export function evaluarEstadoEnlace(
  enlace: EnlaceEvaluable,
  ahora: Date = new Date(),
): EstadoEnlace {
  if (enlace.revocadoEn !== null) return "REVOCADO";
  if (enlace.expiresAt.getTime() <= ahora.getTime()) return "EXPIRADO";
  return "VIGENTE";
}

/** Un enlace sirve solo si está vigente. */
export function enlaceEsUtilizable(
  enlace: EnlaceEvaluable,
  ahora: Date = new Date(),
): boolean {
  return evaluarEstadoEnlace(enlace, ahora) === "VIGENTE";
}

/**
 * Normaliza los días de vigencia pedidos al rango admitido. Valores no
 * positivos, no enteros o ausentes caen al default; por encima del máximo se
 * recorta al máximo en vez de rechazar, para que compartir un documento nunca
 * falle por un número mal escrito.
 */
export function normalizarVigenciaDias(dias?: number): number {
  if (dias === undefined || !Number.isInteger(dias) || dias <= 0) {
    return ENLACE_VIGENCIA_DIAS_DEFAULT;
  }
  return Math.min(dias, ENLACE_VIGENCIA_DIAS_MAX);
}

/** Instante de caducidad a partir de los días de vigencia. */
export function calcularExpiracion(dias: number, desde: Date = new Date()): Date {
  return new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * Token del enlace. 32 bytes de aleatoriedad criptográfica en base64url: es lo
 * único que protege el documento, así que no puede ser adivinable ni derivarse
 * del id del documento.
 */
export function generarTokenEnlace(): string {
  return randomBytes(32).toString("base64url");
}
