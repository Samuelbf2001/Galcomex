"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

/**
 * Error boundary del dashboard: cualquier excepción no controlada en una
 * página o server component cae aquí, dentro del layout (menú visible).
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] error de página", error);
  }, [error]);

  return (
    <section className="mx-auto max-w-xl space-y-5 py-10" role="alert">
      <div className="flex items-start gap-3 border border-rose-200 bg-rose-50 px-5 py-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-rose-900">Algo salió mal al abrir esta sección</h1>
          <p className="mt-1 text-sm text-rose-800">
            El servidor no pudo completar la carga. Tus datos no se han perdido. Puedes reintentar o
            volver al inicio; si el problema continúa, avisa a SixTeam.
          </p>
          {error.digest ? (
            <p className="mt-2 font-mono text-xs text-rose-700">Referencia: {error.digest}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Reintentar
        </button>
        <Link
          href="/"
          className="inline-flex h-10 items-center border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Ir al inicio
        </Link>
      </div>
    </section>
  );
}
