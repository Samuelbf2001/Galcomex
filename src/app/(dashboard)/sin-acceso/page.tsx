import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import type { Rol } from "@/lib/auth/auth";
import { rutaDashboardDe, rutaInicial } from "@/lib/auth/rutas-roles";
import { getCurrentSession } from "@/lib/auth/session";

const NOMBRE_ROL: Record<Rol, string> = {
  ADMIN: "Administración",
  REVISOR: "Revisión",
  OPERATIVO: "Operativo",
  SOCIO: "Socio",
};

export default async function SinAccesoPage({
  searchParams,
}: {
  searchParams: Promise<{ ruta?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/auth/login");

  const { ruta } = await searchParams;
  const rol = session.user.rol as Rol;
  const modulo = ruta ? rutaDashboardDe(ruta)?.label : undefined;
  const inicio = rutaInicial(rol);

  return (
    <section className="mx-auto max-w-xl space-y-5 py-10">
      <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 px-5 py-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
        <div>
          <h1 className="text-lg font-semibold text-amber-900">
            {modulo ? `No tienes acceso a ${modulo}` : "No tienes acceso a esta sección"}
          </h1>
          <p className="mt-1 text-sm text-amber-900/90">
            Tu perfil es <strong>{NOMBRE_ROL[rol]}</strong> y este módulo está reservado a otros
            perfiles. Si necesitas entrar, pídele a Camila (administración) que revise tu acceso.
          </p>
        </div>
      </div>
      <Link
        href={inicio}
        className="inline-flex h-10 items-center bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        Ir a mi pantalla de inicio
      </Link>
    </section>
  );
}
