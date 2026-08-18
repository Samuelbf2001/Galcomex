import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Toda ruta bajo (dashboard) va aquí. `/pagos`, `/ingresos` y `/liquidacion-lm`
// se habían quedado fuera: sus endpoints sí exigen rol, así que los datos nunca
// estuvieron expuestos, pero la página se renderizaba sin sesión. Al agregar una
// pantalla nueva al dashboard hay que sumarla también al `matcher` de abajo.
// `/cambiar-password` queda deliberadamente fuera.
const protectedPrefixes = [
  "/dashboard",
  "/tramites",
  "/facturacion",
  "/cartera",
  "/anticipos",
  "/clientes",
  "/configuracion",
  "/pagos",
  "/ingresos",
  "/liquidacion-lm",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = protectedPrefixes.some((prefix) =>
    pathname.startsWith(prefix),
  );

  if (!isProtected) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const loginUrl = new URL("/auth/login", request.url);
    loginUrl.searchParams.set("next", pathname);
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
    "/anticipos/:path*",
    "/clientes/:path*",
    "/configuracion/:path*",
    "/pagos/:path*",
    "/ingresos/:path*",
    "/liquidacion-lm/:path*",
  ],
};
