import { NextResponse } from "next/server";

/**
 * Respuesta JSON del API con serialización de BigInt → string.
 *
 * Todas las respuestas llevan `Cache-Control: private, no-store`: son datos
 * operativos por sesión (saldos, trámites, borradores) que nunca deben quedar
 * en cachés compartidas ni en el disco del navegador. Un `init.headers`
 * explícito puede sobrescribirlo.
 */
export function jsonResponse<T>(data: T, init?: ResponseInit) {
  return new NextResponse(
    JSON.stringify(data, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        ...init?.headers,
      },
    },
  );
}
