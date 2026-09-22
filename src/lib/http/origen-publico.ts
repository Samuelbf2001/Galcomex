import type { NextRequest } from "next/server";

function esLocal(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
  } catch {
    return true;
  }
}

/**
 * Origen público (https://dominio) con el que el navegador llegó a la app.
 *
 * `request.nextUrl.origin` NO sirve para armar enlaces absolutos en producción:
 * detrás del proxy de EasyPanel/Docker resuelve a `http://localhost:3000`.
 * Orden: `APP_URL` / `NEXT_PUBLIC_APP_URL` si apuntan a un dominio real →
 * cabeceras `x-forwarded-*` del proxy → `host` → `nextUrl.origin` (local).
 */
export function origenPublico(request: NextRequest): string {
  const configurado = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  if (configurado && !esLocal(configurado)) {
    return configurado.replace(/\/+$/, "");
  }

  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    .trim();
  if (host) {
    const proto = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim()
      || request.nextUrl.protocol.replace(/:$/, "");
    const origen = `${proto}://${host}`;
    if (!esLocal(origen)) {
      return origen;
    }
  }

  return request.nextUrl.origin;
}
