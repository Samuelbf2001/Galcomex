"use client";

import { AlertTriangle, Check, Copy, Loader2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  crearEnlace,
  DocumentosApiError,
  revocarEnlace,
  type EnlaceDocumento,
} from "@/components/documentos/documentos-api";

type EnlaceDocumentoModalProps = {
  tramiteId: string;
  documentoId: string;
  nombreArchivo: string;
  onClose: () => void;
};

function formatFechaLarga(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function EnlaceDocumentoModal({
  tramiteId,
  documentoId,
  nombreArchivo,
  onClose,
}: EnlaceDocumentoModalProps) {
  const [estado, setEstado] = useState<"cargando" | "listo" | "revocado" | "error">("cargando");
  const [enlace, setEnlace] = useState<EnlaceDocumento | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [revocando, setRevocando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    void crearEnlace(tramiteId, documentoId)
      .then((e) => {
        if (cancelado) return;
        setEnlace(e);
        setEstado("listo");
      })
      .catch((caught) => {
        if (cancelado) return;
        setError(
          caught instanceof DocumentosApiError
            ? caught.message
            : "No fue posible crear el enlace para compartir.",
        );
        setEstado("error");
      });

    return () => {
      cancelado = true;
    };
  }, [tramiteId, documentoId]);

  async function handleCopiar() {
    if (!enlace) return;
    try {
      await navigator.clipboard.writeText(enlace.url);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setError("No fue posible copiar el enlace. Selecciónalo y cópialo manualmente.");
    }
  }

  async function handleRevocar() {
    if (!enlace) return;
    if (!confirm("¿Revocar este enlace? Quien lo tenga ya no podrá usarlo para descargar el documento.")) {
      return;
    }
    setRevocando(true);
    setError(null);
    try {
      await revocarEnlace(tramiteId, documentoId, enlace.id);
      setEstado("revocado");
    } catch (caught) {
      setError(
        caught instanceof DocumentosApiError ? caught.message : "No fue posible revocar el enlace.",
      );
    } finally {
      setRevocando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Compartir documento"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md border border-slate-200 bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Compartir documento</h2>
            <p className="mt-0.5 truncate text-xs text-slate-500" title={nombreArchivo}>
              {nombreArchivo}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-slate-400 transition hover:text-slate-700"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {estado === "cargando" && (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Generando enlace…
          </div>
        )}

        {estado === "error" && (
          <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}

        {estado === "listo" && enlace && (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                Enlace público (cualquiera con este link puede descargar el archivo)
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={enlace.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-10 min-w-0 flex-1 border border-slate-300 bg-slate-50 px-3 text-xs text-slate-700 outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleCopiar()}
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  {copiado ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {copiado ? "Copiado" : "Copiar"}
                </button>
              </div>
            </label>

            <p className="text-xs text-slate-500">
              Expira el <span className="font-medium text-slate-700">{formatFechaLarga(enlace.expiraEn)}</span>
            </p>

            {error && (
              <p className="text-xs text-rose-600">
                <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => void handleRevocar()}
              disabled={revocando}
              className="inline-flex h-9 items-center gap-1.5 border border-rose-200 bg-white px-3 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-60"
            >
              {revocando ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Revocar enlace
            </button>
          </div>
        )}

        {estado === "revocado" && (
          <div className="py-4 text-center">
            <p className="text-sm font-medium text-slate-900">Enlace revocado.</p>
            <p className="mt-1 text-xs text-slate-500">
              El link ya no funciona. Puedes generar uno nuevo desde &quot;Compartir&quot; cuando lo
              necesites.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 inline-flex h-9 items-center justify-center border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
