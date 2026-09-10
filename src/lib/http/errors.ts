import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function validationError(error: ZodError) {
  return NextResponse.json(
    {
      error: "Payload invalido",
      details: error.issues.map((issue) => ({
        campo: issue.path.join("."),
        mensaje: issue.message,
      })),
    },
    { status: 400 },
  );
}

/**
 * Errores de dominio tipados en toda la app siguen el patrón
 * `class XError extends Error { public readonly status = <código>; }`.
 * Este helper es un fallback GENÉRICO para el catch de las rutas: se usa
 * DESPUÉS de los `instanceof` específicos de cada ruta (que pueden querer
 * enriquecer el payload, ej. `faltantes`), justo antes del `throw error`
 * final, para que cualquier error de dominio con `.status` se traduzca a
 * JSON en vez de reventar como 500 sin manejar.
 *
 * Introducido junto con `TramiteCerradoError` (src/lib/tramites/guard.ts,
 * status 409) para no tener que repetir un `instanceof TramiteCerradoError`
 * en cada una de las rutas que mutan un trámite.
 */
export function isDomainError(error: unknown): error is Error & { status: number } {
  return (
    error instanceof Error &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

export function domainErrorResponse(error: Error & { status: number }) {
  return NextResponse.json({ error: error.message }, { status: error.status });
}
