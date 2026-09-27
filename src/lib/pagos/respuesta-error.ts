/**
 * Traducción de errores a HTTP para las rutas de dinero de CxP v2 (P1).
 *
 * Contrato (diseño §B.7): status del error y cuerpo `{ error, codigo, detalles? }`
 * para los errores tipados de CxP (`CxpError`); `{ error }` con su status para
 * los demás errores de dominio (DO cerrado, documento de otro DO, canal sin
 * matriz…); 400 con el detalle de Zod para un payload inválido. Devuelve null
 * si el error no es de dominio (la ruta lo relanza → 500).
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { CxpError, cuerpoErrorCxp } from "@/lib/cxp/errores";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";

export function respuestaErrorPagos(error: unknown): NextResponse | null {
  if (error instanceof ZodError) return validationError(error);
  if (error instanceof CxpError) {
    return NextResponse.json(cuerpoErrorCxp(error), { status: error.status });
  }
  if (isDomainError(error)) return domainErrorResponse(error);
  return null;
}
