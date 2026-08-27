import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth/auth";
import {
  construirClaveLimite,
  limpiarIntentos,
  registrarIntentoFallido,
  verificarLimite,
} from "@/lib/http/rate-limit";

/**
 * Resuelve la IP del cliente a partir de los headers de proxy/reverse-proxy
 * habituales. NextRequest ya no expone `.ip` en Next 15; en despliegue
 * detrás de un proxy (nginx, Docker) `x-forwarded-for` trae la IP real.
 */
function resolverIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]!.trim();
  }
  return request.headers.get("x-real-ip") ?? "desconocida";
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const callbackURL = String(formData.get("callbackURL") ?? "/dashboard");
  const origin = request.nextUrl.origin;

  const claveLimite = construirClaveLimite(resolverIp(request), email);
  const limite = verificarLimite(claveLimite);

  if (limite.bloqueado) {
    const minutos = Math.ceil(limite.segundosRestantes / 60);
    return NextResponse.json(
      {
        error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutos} minuto${minutos === 1 ? "" : "s"}.`,
      },
      { status: 429 },
    );
  }

  const authResponse = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({
        email,
        password,
        callbackURL,
      }),
    }),
  );

  if (!authResponse.ok) {
    registrarIntentoFallido(claveLimite);
    const loginUrl = new URL("/auth/login", origin);
    loginUrl.searchParams.set("error", "credenciales");
    loginUrl.searchParams.set("next", callbackURL);
    return NextResponse.redirect(loginUrl);
  }

  limpiarIntentos(claveLimite);

  const isSafeCallback =
    callbackURL.startsWith("/") && !callbackURL.startsWith("//") && !callbackURL.startsWith("/\\");
  const redirectTo = isSafeCallback ? callbackURL : "/dashboard";
  const response = NextResponse.redirect(new URL(redirectTo, origin));
  const setCookie = authResponse.headers.get("set-cookie");

  if (setCookie) {
    response.headers.set("set-cookie", setCookie);
  }

  return response;
}
