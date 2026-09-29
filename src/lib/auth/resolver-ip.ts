import type { NextRequest } from "next/server";

/**
 * Resuelve la IP del cliente a partir de los headers de proxy/reverse-proxy
 * habituales. NextRequest ya no expone `.ip` en Next 15; en despliegue
 * detrás de Traefik, `x-forwarded-for` es una lista `cliente, proxy1, ...`
 * donde cada proxy AÑADE su valor al final. El PRIMER valor lo pone el
 * propio cliente y puede falsificarse a mano (evade el límite de intentos);
 * el ÚLTIMO valor no vacío es el que agrega Traefik, el proxy de confianza,
 * y es el único que no se puede suplantar desde fuera.
 *
 * Vive aquí y no en `app/api/login/route.ts`: Next solo deja exportar
 * handlers y config desde un route.ts, y `next build` falla si se exporta
 * cualquier otra cosa.
 */
export function resolverIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const valores = forwardedFor
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (valores.length > 0) return valores[valores.length - 1]!;
  }
  return request.headers.get("x-real-ip") ?? "desconocida";
}
