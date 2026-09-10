import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth/auth";
import { destinoInternoSeguro } from "@/lib/auth/rutas-roles";
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

  // API de servidor de Better Auth con las cabeceras reales del navegador
  // (origin/host del cliente). Antes se fabricaba una Request con
  // `request.nextUrl.origin`, que dentro de Docker resuelve a localhost:3000 y
  // Better Auth la rechazaba como "Invalid origin".
  const authResponse = await auth.api.signInEmail({
    body: { email, password },
    headers: request.headers,
    asResponse: true,
  });

  // El formulario con JavaScript pide JSON; sin JavaScript (action del form)
  // se mantiene el flujo de redirecciones.
  const quiereJson = (request.headers.get("accept") ?? "").includes("application/json");

  if (!authResponse.ok) {
    registrarIntentoFallido(claveLimite);
    if (quiereJson) {
      return NextResponse.json({ error: "Correo o contraseña inválidos." }, { status: 401 });
    }
    const loginUrl = new URL("/auth/login", origin);
    loginUrl.searchParams.set("error", "credenciales");
    loginUrl.searchParams.set("next", callbackURL);
    return NextResponse.redirect(loginUrl);
  }

  limpiarIntentos(claveLimite);

  // "/" delega en la página raíz, que envía a cada rol a su pantalla inicial.
  const redirectTo = destinoInternoSeguro(callbackURL) ?? "/";
  const response = quiereJson
    ? NextResponse.json({ ok: true, redirectTo })
    : NextResponse.redirect(new URL(redirectTo, origin));

  // Better Auth emite VARIAS cookies (session_token + session_data por la
  // caché de cookie): hay que copiarlas una a una, no como cabecera única.
  for (const cookie of authResponse.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }

  return response;
}
