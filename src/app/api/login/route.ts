import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth/auth";
import {
  CODIGO_USUARIO_DESACTIVADO,
  MENSAJE_USUARIO_DESACTIVADO,
  tieneClaveTemporal,
} from "@/lib/auth/estado-cuenta";
import { destinoInternoSeguro } from "@/lib/auth/rutas-roles";
import {
  construirClaveLimite,
  limpiarIntentos,
  registrarIntentoFallido,
  verificarLimite,
} from "@/lib/http/rate-limit";

/** Lee el JSON de la respuesta de Better Auth sin consumirla. */
async function leerCuerpo(response: Response): Promise<Record<string, unknown> | null> {
  const cuerpo: unknown = await response.clone().json().catch(() => null);
  return typeof cuerpo === "object" && cuerpo !== null ? (cuerpo as Record<string, unknown>) : null;
}

/**
 * Resuelve la IP del cliente a partir de los headers de proxy/reverse-proxy
 * habituales. NextRequest ya no expone `.ip` en Next 15; en despliegue
 * detrás de Traefik, `x-forwarded-for` es una lista `cliente, proxy1, ...`
 * donde cada proxy AÑADE su valor al final. El PRIMER valor lo pone el
 * propio cliente y puede falsificarse a mano (evade el límite de intentos);
 * el ÚLTIMO valor no vacío es el que agrega Traefik, el proxy de confianza,
 * y es el único que no se puede suplantar desde fuera.
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

export async function POST(request: NextRequest) {
  // El formulario de login manda form-data; cualquier otro cuerpo (JSON,
  // vacío) es una petición mal formada, no un error del servidor.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Solicitud inválida: envía el formulario de inicio de sesión." },
      { status: 400 },
    );
  }
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
    // Cuenta desactivada: el hook `session.create.before` de auth.ts la frena
    // DESPUÉS de verificar la contraseña, así que el aviso solo lo ve quien
    // tiene la clave correcta. No cuenta como intento fallido.
    if (authResponse.status === 403) {
      const cuerpo = await leerCuerpo(authResponse);
      if (cuerpo?.code === CODIGO_USUARIO_DESACTIVADO) {
        if (quiereJson) {
          return NextResponse.json(
            { error: MENSAJE_USUARIO_DESACTIVADO, codigo: CODIGO_USUARIO_DESACTIVADO },
            { status: 403 },
          );
        }
        const loginUrl = new URL("/auth/login", origin);
        loginUrl.searchParams.set("error", "desactivado");
        return NextResponse.redirect(loginUrl);
      }
    }

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

  // Con clave temporal va directo a cambiarla (el guard de página lo haría
  // igual, pero así se ahorra un rebote). Si no, "/" delega en la página raíz,
  // que envía a cada rol a su pantalla inicial.
  const cuerpo = await leerCuerpo(authResponse);
  const usuario = cuerpo?.user;
  const claveTemporal =
    typeof usuario === "object" && usuario !== null && tieneClaveTemporal(usuario);
  const redirectTo = claveTemporal
    ? "/cambiar-password"
    : (destinoInternoSeguro(callbackURL) ?? "/");
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
