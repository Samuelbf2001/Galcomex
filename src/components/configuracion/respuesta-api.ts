/**
 * Lectura defensiva del cuerpo de error de las rutas API de configuración.
 * Prioriza el detalle de validación Zod (`details[0]`) sobre el `error`
 * genérico ("Payload invalido") para que el usuario vea qué campo falló.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function leerErrorRespuesta(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;

  if (Array.isArray(payload.details)) {
    const primero = payload.details.find(isRecord);
    if (primero && typeof primero.mensaje === "string" && primero.mensaje.trim()) {
      return primero.mensaje;
    }
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  return fallback;
}

/** `fetch` + lectura del cuerpo; lanza `Error` con el mensaje real del servidor. */
export async function patchJson(url: string, body: unknown, fallback: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(leerErrorRespuesta(payload, fallback));
  }
  return payload;
}
