/**
 * Esquemas Zod comunes (CxP v2, diseño §D.7). Los usan los esquemas de pagos
 * (P1), facturas de proveedor y beneficiarios (P2) y los nuevos de CxP.
 */

import { z } from "zod";

import { aFechaCalendario } from "@/lib/tiempo/bogota";

/**
 * Fecha-calendario (factura, pago, TRM, cruce): "YYYY-MM-DD", un ISO o un Date
 * → 00:00 UTC del día (ver `aFechaCalendario`). Reemplaza `z.coerce.date()`,
 * que corría un día las fechas escritas después de las 19:00 en Bogotá.
 */
export const fechaCalendarioSchema = z.union([z.string(), z.date()]).transform((v, ctx) => {
  try {
    return aFechaCalendario(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Fecha inválida" });
    return z.NEVER;
  }
});

/** Igual, opcional y anulable (null limpia la fecha). */
export const fechaCalendarioOpcionalSchema = fechaCalendarioSchema.optional().nullable();

const RE_ENTERO = /^\d{1,18}$/;

/**
 * Dinero COP entero ≥ 0 (BigInt). Acepta string de solo dígitos ("464077"),
 * number entero seguro o bigint. Rechaza puntos, comas, decimales, signos,
 * notación hexadecimal y exponentes (BigInt("0x10") = 16 no debe colarse).
 */
export const dineroCopSchema = z
  .union([
    z.string().trim().regex(RE_ENTERO, "Valor inválido: escribe solo dígitos, sin puntos ni decimales"),
    z.number().int().nonnegative().refine(Number.isSafeInteger, "Valor demasiado grande"),
    z.bigint().nonnegative(),
  ])
  .transform((v) => BigInt(v));

/** Dinero COP entero > 0. */
export const dineroCopPositivoSchema = dineroCopSchema.refine((v) => v > 0n, {
  message: "El valor debe ser mayor que cero",
});

/** Clave de idempotencia que genera la pantalla (`crypto.randomUUID()`). */
export const claveIdempotenciaSchema = z.string().trim().uuid("Clave de idempotencia inválida");

/** Motivo de una anulación o de quitar un ajuste (ADMIN): al menos 10 caracteres. */
export const motivoSchema = z
  .string()
  .trim()
  .min(10, "Escribe el motivo (al menos 10 caracteres)")
  .max(500, "El motivo es demasiado largo (máximo 500 caracteres)");
