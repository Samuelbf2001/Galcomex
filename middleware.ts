import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Primera línea de defensa: sin cookie de sesión no se entra a ninguna ruta
 * del dashboard (incluye ahora pagos, ingresos, liquidación LM, cambiar
 * contraseña y sin-acceso, que antes llegaban hasta el layout).
 *
 * La comprobación de ROL por página la hace `exigirAccesoPagina` en cada
 * page.tsx (necesita la sesión completa; aquí solo miramos la cookie).
 */
const protectedPrefixes = [
  "/dashboard",
  "/tramites",
  "/facturacion",
  "/cartera",
  "/liquidacion-lm",
  "/anticipos",
  "/ingresos",
  "/pagos",
  "/clientes",
  "/configuracion",
  "/cambiar-password",
  "/sin-acceso",
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isProtected = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (!isProtected) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const loginUrl = new URL("/auth/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/tramites/:path*",
    "/facturacion/:path*",
    "/cartera/:path*",
    "/liquidacion-lm/:path*",
    "/anticipos/:path*",
    "/ingresos/:path*",
    "/pagos/:path*",
    "/clientes/:path*",
    "/configuracion/:path*",
    "/cambiar-password/:path*",
    "/sin-acceso/:path*",
  ],
};
