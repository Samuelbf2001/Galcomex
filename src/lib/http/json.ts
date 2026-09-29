import { NextResponse } from "next/server";

import { stringifyDinero } from "@/lib/dinero";

/**
 * Respuesta JSON del API. Serializa con el serializador único de dinero
 * (`stringifyDinero`, fase centavos A.5): todo `bigint` (centavos) sale como
 * PESOS en texto con 2 decimales (`50280145n` → `"502801.45"`), las llaves
 * pierden el sufijo `Centavos` (`valorCentavos` → `valor`) y un choque de
 * llaves (`valor` y `valorCentavos` en el mismo objeto) lanza.
 *
 * Todas las respuestas llevan `Cache-Control: private, no-store`: son datos
 * operativos por sesión (saldos, trámites, borradores) que nunca deben quedar
 * en cachés compartidas ni en el disco del navegador. Un `init.headers`
 * explícito puede sobrescribirlo.
 */
export function jsonResponse<T>(data: T, init?: ResponseInit) {
  return new NextResponse(stringifyDinero(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      ...init?.headers,
    },
  });
}
