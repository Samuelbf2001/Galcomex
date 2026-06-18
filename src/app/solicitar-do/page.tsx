import type { Metadata } from "next";

import { SolicitudForm } from "@/app/solicitar-do/solicitud-form";

export const metadata: Metadata = {
  title: "Solicitar apertura de DO — Galcomex",
  description: "Registre su solicitud de apertura de trámite de importación con Galcomex.",
};

export default function SolicitarDoPage() {
  return (
    <main className="grid min-h-dvh bg-slate-100 text-slate-950 lg:grid-cols-[1fr_480px]">
      {/* Panel izquierdo informativo */}
      <section className="hidden border-r border-slate-200 bg-slate-950 px-12 py-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div>
          <p className="text-sm font-semibold text-cyan-300">Galcomex</p>
          <h1 className="mt-4 max-w-xl text-4xl font-semibold leading-tight">
            Solicitud de apertura de trámite de importación
          </h1>
          <p className="mt-4 max-w-sm text-sm text-slate-400">
            Complete el formulario para iniciar su proceso. Un agente de Galcomex
            revisará su solicitud y le confirmará la apertura del DO.
          </p>
        </div>
        <div className="space-y-3 text-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">
            ¿Qué sucede después?
          </p>
          {[
            { num: "01", texto: "Su solicitud queda registrada con un número de radicado único." },
            { num: "02", texto: "El equipo de Galcomex verifica la documentación requerida." },
            { num: "03", texto: "Se asigna el DO definitivo y se inicia el trámite ante la agencia de aduanas." },
          ].map((paso) => (
            <div key={paso.num} className="flex gap-3 border border-slate-700 px-4 py-3">
              <span className="text-xs font-bold text-cyan-400">{paso.num}</span>
              <p className="text-slate-300">{paso.texto}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Formulario */}
      <section className="flex items-start justify-center px-5 py-10 lg:items-center">
        <div className="w-full max-w-md border border-slate-200 bg-white p-6">
          <div className="mb-6">
            <p className="block text-xs font-semibold uppercase text-cyan-700 lg:hidden">
              Galcomex
            </p>
            <p className="mt-1 text-xs font-semibold uppercase text-cyan-700 lg:block hidden">
              Solicitud de trámite
            </p>
            <h2 className="mt-2 text-xl font-semibold">Apertura de DO</h2>
            <p className="mt-1 text-sm text-slate-500">
              Ingrese su NIT y los datos del trámite. Todos los campos marcados
              con <span className="text-red-500">*</span> son obligatorios.
            </p>
          </div>
          <SolicitudForm />
          <p className="mt-4 text-center text-xs text-slate-400">
            ¿Necesita ayuda?{" "}
            <a
              href="mailto:operaciones@galcomex.com"
              className="text-cyan-700 hover:underline"
            >
              Contacte a Galcomex
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
