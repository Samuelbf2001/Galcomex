import { NextResponse } from "next/server";

import { CxpError, cuerpoErrorCxp } from "@/lib/cxp/errores";
import { jsonResponse } from "@/lib/http/json";

import { FichaError } from "./errores";

/**
 * Respuesta `{ error, codigo, detalles? }` para los errores de fichas de pago
 * que pueden salir al crear o editar una EMPRESA (su ficha se asegura en la
 * misma transacción): repetidos por NIT, DV mal escrito, empresa con pagos.
 * `null` si el error no es de ese tipo (la ruta sigue con su manejo).
 */
export function respuestaErrorFicha(error: unknown): NextResponse | null {
  if (error instanceof FichaError) {
    return NextResponse.json(
      { error: error.message, codigo: error.codigo, ...(error.detalles ? { detalles: error.detalles } : {}) },
      { status: error.status },
    );
  }
  if (error instanceof CxpError) {
    return jsonResponse(cuerpoErrorCxp(error), { status: error.status });
  }
  // Otros errores de dominio de fichas con código (p. ej. BENEFICIARIO_DATOS_INVALIDOS).
  if (error instanceof Error) {
    const { status, codigo } = error as { status?: unknown; codigo?: unknown };
    if (typeof status === "number" && status >= 400 && status < 500 && typeof codigo === "string") {
      return NextResponse.json({ error: error.message, codigo }, { status });
    }
  }
  return null;
}

/** `?confirmarOtraFicha=1`: la empresa es otra aunque su NIT se parezca al de un proveedor existente. */
export function confirmaOtraFicha(url: URL): boolean {
  const v = url.searchParams.get("confirmarOtraFicha");
  return v === "1" || v === "true";
}
