import { redirect } from "next/navigation";

import type { Rol } from "@/lib/auth/auth";
import { rutaInicial } from "@/lib/auth/rutas-roles";
import { getCurrentSession } from "@/lib/auth/session";

/** Entrada: cada rol va a su primera pantalla útil (el SOCIO a Trámites, no al dashboard). */
export default async function Home() {
  const session = await getCurrentSession();
  redirect(session ? rutaInicial(session.user.rol as Rol) : "/auth/login");
}
