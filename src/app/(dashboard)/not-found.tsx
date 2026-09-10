import { SearchX } from "lucide-react";
import Link from "next/link";

/** 404 dentro del dashboard (menú visible): ids inexistentes o rutas mal escritas. */
export default function DashboardNotFound() {
  return (
    <section className="mx-auto max-w-xl space-y-5 py-10">
      <div className="flex items-start gap-3 border border-slate-300 bg-white px-5 py-4">
        <SearchX className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
        <div>
          <h1 className="text-lg font-semibold">Esta página no existe</h1>
          <p className="mt-1 text-sm text-slate-600">
            La dirección puede estar mal escrita o el registro fue eliminado. Usa el menú de la
            izquierda o vuelve al inicio.
          </p>
        </div>
      </div>
      <Link
        href="/"
        className="inline-flex h-10 items-center bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        Ir al inicio
      </Link>
    </section>
  );
}
