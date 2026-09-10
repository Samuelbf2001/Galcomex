import { SearchX } from "lucide-react";
import Link from "next/link";

/** 404 global (fuera del dashboard): reemplaza la página en inglés de Next.js. */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-100 px-5 text-slate-950">
      <div className="w-full max-w-md border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3">
          <SearchX className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold uppercase text-cyan-700">Error 404</p>
            <h1 className="mt-1 text-xl font-semibold">Esta página no existe</h1>
            <p className="mt-2 text-sm text-slate-600">
              La dirección puede estar mal escrita o ya no está disponible.
            </p>
          </div>
        </div>
        <Link
          href="/"
          className="mt-5 inline-flex h-10 w-full items-center justify-center bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          Volver al sistema
        </Link>
      </div>
    </main>
  );
}
