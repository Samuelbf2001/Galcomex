import type { RolSimulable } from "@/lib/auth/rol-simulado";

/**
 * Llamadas del navegador a `/api/usuarios/rol-simulado` («Probar como otro
 * rol»). Lanzan `Error` con el mensaje del servidor si la respuesta no es OK.
 */

const RUTA = "/api/usuarios/rol-simulado";

async function mensajeDeError(respuesta: Response, porDefecto: string): Promise<string> {
  try {
    const cuerpo: unknown = await respuesta.json();
    if (
      typeof cuerpo === "object" &&
      cuerpo !== null &&
      "error" in cuerpo &&
      typeof cuerpo.error === "string" &&
      cuerpo.error.trim()
    ) {
      return cuerpo.error;
    }
  } catch {
    // Sin cuerpo JSON: se usa el mensaje por defecto.
  }
  return porDefecto;
}

/** Empieza a probar la plataforma como ese rol (solo la administradora). */
export async function iniciarPruebaRol(rol: RolSimulable): Promise<void> {
  const respuesta = await fetch(RUTA, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rol }),
  });
  if (!respuesta.ok) {
    throw new Error(await mensajeDeError(respuesta, "No se pudo cambiar de rol."));
  }
}

/** Vuelve a administradora. Con `esperaMaxMs` no se queda colgado (p. ej. al cerrar sesión). */
export async function terminarPruebaRol(esperaMaxMs?: number): Promise<void> {
  const respuesta = await fetch(RUTA, {
    method: "DELETE",
    signal: esperaMaxMs ? AbortSignal.timeout(esperaMaxMs) : undefined,
  });
  if (!respuesta.ok) {
    throw new Error(await mensajeDeError(respuesta, "No se pudo volver a administradora."));
  }
}

/**
 * Recarga completa hacia `ruta`. A propósito NO usa `router.push`: al cambiar
 * de rol el menú, las páginas y todo lo que ya cargó el navegador deben
 * rehacerse desde cero con el rol nuevo (cachés del router y estado de los
 * componentes incluidos).
 */
export function recargarEn(ruta: string): void {
  window.location.href = ruta;
}
