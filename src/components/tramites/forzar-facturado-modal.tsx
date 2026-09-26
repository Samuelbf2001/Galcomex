"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { ModalShell } from "@/components/ui/modal-shell";
import { MOTIVO_FORZAR_MIN, motivoValido } from "@/lib/tramites/motivo-forzar";

/**
 * Excepción del ADMIN a «Facturado solo con factura emitida» (decisión de
 * Ernesto, 25-sep-2026): el servidor rechazó el paso con `FACTURA_NO_EMITIDA`
 * y `detalles.puedeForzar`; aquí el ADMIN escribe el motivo y se reintenta el
 * mismo cambio con `motivoExcepcion`. Queda un AuditLog `FORZAR_FACTURADO`.
 */
export function ForzarFacturadoModal({
  consecutivo,
  estadoDestino,
  mensaje,
  onCancelar,
  onForzar,
}: {
  consecutivo: string;
  estadoDestino: string;
  /** Mensaje del servidor (qué tiene hoy el DO). */
  mensaje: string;
  onCancelar: () => void;
  /** Reintenta el cambio con el motivo; si lanza, el error se muestra aquí. */
  onForzar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limpio = motivoValido(motivo);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!limpio || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await onForzar(limpio);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible forzar el cambio.");
    } finally {
      setEnviando(false);
    }
  }

  const destino = estadoDestino.replace(/_/g, " ").toLowerCase();

  return (
    <ModalShell
      open
      onClose={onCancelar}
      title={`Pasar ${consecutivo} a ${destino} sin factura`}
      description="Solo el administrador puede hacerlo, y queda anotado con tu nombre y el motivo."
      size="md"
      dismissible={!enviando}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{mensaje}</span>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Motivo *</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Ej.: va incluido en la factura BAQ-18701 del DO.CTG26-0209"
            className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-cyan-600"
          />
          <span className="block text-xs text-slate-500">
            Mínimo {MOTIVO_FORZAR_MIN} caracteres.
          </span>
        </label>

        {error ? (
          <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={onCancelar}
            disabled={enviando}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!limpio || enviando}
            className="inline-flex h-10 items-center gap-2 border border-amber-600 bg-amber-600 px-4 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
          >
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Forzar con este motivo
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
