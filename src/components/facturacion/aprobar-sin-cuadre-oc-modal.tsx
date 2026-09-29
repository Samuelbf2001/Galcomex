"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { ModalShell } from "@/components/ui/modal-shell";
import { MOTIVO_EXCEPCION_OC_MIN } from "@/lib/borradores/orden-compra";

/**
 * Excepción de la administradora al freno de la orden de compra (B4, Diseño B):
 * el servidor rechazó la aprobación con `OC_NO_CUADRA` u `OC_SIN_VALOR`; aquí la
 * ADMIN escribe el motivo y se reintenta con `motivoExcepcionOc`. Queda un
 * AuditLog `APROBAR_SIN_CUADRE_OC` con quién y por qué. Solo se abre para ADMIN;
 * a un REVISOR se le muestra el mensaje y se le pide devolver la factura.
 */
export function AprobarSinCuadreOcModal({
  consecutivo,
  mensaje,
  onCancelar,
  onAprobar,
}: {
  consecutivo: string;
  /** Mensaje del servidor (qué suma la factura y cuánto es la OC). */
  mensaje: string;
  onCancelar: () => void;
  /** Reintenta la aprobación con el motivo; si lanza, el error se muestra aquí. */
  onAprobar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limpio = motivo.trim();
  const valido = limpio.length >= MOTIVO_EXCEPCION_OC_MIN;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valido || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await onAprobar(limpio);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible aprobar la factura.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onCancelar}
      title={`Aprobar ${consecutivo} aunque no cuadre con la orden de compra`}
      description="Solo la administradora puede hacerlo, y queda anotado con tu nombre y el motivo."
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
            placeholder="Ej.: el cliente aceptó la diferencia por correo del 29-sep"
            className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-cyan-600"
          />
          <span className="block text-xs text-slate-500">Mínimo {MOTIVO_EXCEPCION_OC_MIN} caracteres.</span>
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
            disabled={!valido || enviando}
            className="inline-flex h-10 items-center gap-2 border border-amber-600 bg-amber-600 px-4 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
          >
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Aprobar con este motivo
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
