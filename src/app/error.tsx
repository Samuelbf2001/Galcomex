"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

/** Error boundary raíz (login, páginas públicas). */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] error no controlado", error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-slate-100 px-5 text-slate-950" role="alert">
      <div className="w-full max-w-md border border-rose-200 bg-white p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-semibold">Algo salió mal</h1>
            <p className="mt-2 text-sm text-slate-600">
              No pudimos cargar esta página. Reintenta en unos segundos; si el problema continúa,
              avisa a SixTeam.
            </p>
            {error.digest ? (
              <p className="mt-2 font-mono text-xs text-slate-500">Referencia: {error.digest}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 flex-1 items-center justify-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reintentar
          </button>
          <Link
            href="/"
            className="inline-flex h-10 flex-1 items-center justify-center border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Ir al inicio
          </Link>
        </div>
      </div>
    </main>
  );
}
