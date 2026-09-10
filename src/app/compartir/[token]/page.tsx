"use client";

import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

type Estado = "cargando" | "listo" | "no-disponible";

export default function CompartirPage({ params }: { params: Promise<{ token: string }> }) {
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [estado, setEstado] = useState<Estado>("cargando");

  useEffect(() => {
    params
      .then(({ token }) =>
        fetch(`/api/compartir/${token}`, { cache: "no-store" }).then(async (r) => {
          if (!r.ok) {
            setEstado("no-disponible");
            return;
          }
          const data = (await r.json()) as { nombreArchivo: string; downloadUrl: string };
          setNombreArchivo(data.nombreArchivo);
          setDownloadUrl(data.downloadUrl);
          setEstado("listo");
        }),
      )
      .catch(() => setEstado("no-disponible"));
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm border border-slate-200 bg-white p-8 shadow-sm">
        {/* Logo / marca */}
        <p className="mb-6 text-center text-xs font-semibold uppercase tracking-widest text-slate-400">
          Galcomex · Documento compartido
        </p>

        {estado === "cargando" && (
          <div className="flex flex-col items-center gap-3 py-8 text-slate-500">
            <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
            <span className="text-sm">Verificando enlace…</span>
          </div>
        )}

        {estado === "listo" && downloadUrl && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <p className="text-sm text-slate-500">Documento compartido contigo:</p>
            <p className="break-words font-semibold text-slate-900">{nombreArchivo}</p>
            <a
              href={downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 w-full items-center justify-center gap-2 bg-slate-950 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Descargar documento
            </a>
          </div>
        )}

        {estado === "no-disponible" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertTriangle className="h-10 w-10 text-amber-500" aria-hidden="true" />
            <p className="font-semibold text-slate-900">Enlace no disponible</p>
            <p className="text-sm text-slate-500">
              Este enlace no es válido, ya expiró o fue revocado. Solicita uno nuevo a quien te lo
              compartió.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
