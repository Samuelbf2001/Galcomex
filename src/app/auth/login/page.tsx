import { redirect } from "next/navigation";

import { LoginForm } from "@/app/auth/login/login-form";
import { getCurrentSession } from "@/lib/auth/session";

export default async function LoginPage() {
  const session = await getCurrentSession();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="grid min-h-dvh bg-slate-100 text-slate-950 lg:grid-cols-[1fr_420px]">
      <section className="hidden border-r border-slate-200 bg-slate-950 px-12 py-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div>
          <p className="text-sm font-semibold text-cyan-300">Galcomex</p>
          <h1 className="mt-4 max-w-xl text-4xl font-semibold leading-tight">
            Gestion operativa y facturacion interna
          </h1>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          {["DOs", "Pagos", "Cartera"].map((label) => (
            <div key={label} className="border border-slate-700 px-3 py-4">
              <p className="font-medium">{label}</p>
              <p className="mt-1 text-xs text-slate-400">Control diario</p>
            </div>
          ))}
        </div>
      </section>
      <section className="flex items-center justify-center px-5">
        <div className="w-full max-w-sm border border-slate-200 bg-white p-6">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase text-cyan-700">
              Acceso interno
            </p>
            <h2 className="mt-2 text-2xl font-semibold">Iniciar sesion</h2>
          </div>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
