import { redirect } from "next/navigation";

import type { AuthSession, Rol } from "@/lib/auth/auth";
import { estaDesactivado } from "@/lib/auth/estado-cuenta";
import { rutaPermitida } from "@/lib/auth/rutas-roles";
import { debeCambiarPasswordAhora, getSesionCruda } from "@/lib/auth/session";

/**
 * Guard de página por rol (server). Cada `page.tsx` del dashboard lo llama
 * con su propia ruta; si el rol no puede abrirla, redirige a /sin-acceso.
 *
 *   export default async function CarteraPage() {
 *     await exigirAccesoPagina("/cartera");
 *     …
 *   }
 *
 * Antes del rol revisa la cuenta: desactivada → /auth/login con el aviso;
 * con clave temporal → /cambiar-password (esa página no llama al guard, así
 * que no hay bucle).
 *
 * Complementa al middleware (que solo comprueba que exista cookie) y al
 * sidebar (que solo decide qué ítems pintar). El API sigue validando por su
 * cuenta con `requireRole`.
 */
export async function exigirAccesoPagina(ruta: string): Promise<AuthSession> {
  const session = await getSesionCruda();

  if (!session) {
    redirect(`/auth/login?next=${encodeURIComponent(ruta)}`);
  }

  if (estaDesactivado(session.user)) {
    redirect("/auth/login?error=desactivado");
  }

  if (await debeCambiarPasswordAhora(session)) {
    redirect("/cambiar-password");
  }

  if (!rutaPermitida(ruta, session.user.rol as Rol)) {
    redirect(`/sin-acceso?ruta=${encodeURIComponent(ruta)}`);
  }

  return session;
}
