"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { anularPagoGrupo } from "@/components/pagos/pagos-global-api";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin } from "@/lib/auth/rol-context";

/**
 * Diálogo "Anular pago en bloque" (CxP v2, diseño §B.4, §D.1) — solo ADMIN:
 * revierte el saldo de TODAS las facturas del bloque, borra sus `PagoTramite`
 * y marca `PagoGrupo.estado = ANULADO`. Si algún DO del bloque está CERRADO,
 * el servidor rechaza la anulación completa (409 `BLOQUE_CON_DO_CERRADO`) y no
 * toca nada — el mensaje del servidor ya trae la lista de DOs.
 *
 * El componente que lo monta decide QUIÉN lo ve (regla R16: "anular bloque…
 * solo ADMIN"); aquí se repite el chequeo como defensa en profundidad.
 */
export type AnularBloqueDialogProps = {
  grupoPagoId: string;
  /** Resumen legible del bloque para el encabezado ("Fecha · Valor · N DOs"). */
  resumen: string;
  onClose: () => void;
  onDone: () => void;
};

const MOTIVO_MIN = 10;

export function AnularBloqueDialog({ grupoPagoId, resumen, onClose, onDone }: AnularBloqueDialogProps) {
  const esAdmin = useEsAdmin();
  const { toast } = useToast();
  const [motivo, setMotivo] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!esAdmin) return null;

  const motivoValido = motivo.trim().length >= MOTIVO_MIN;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);
    if (!motivoValido) {
      setError(`Escribe el motivo (al menos ${MOTIVO_MIN} caracteres).`);
      return;
    }
    setIsSubmitting(true);
    try {
      await anularPagoGrupo(grupoPagoId, motivo.trim());
      toast({ title: "Pago en bloque anulado", description: resumen, variant: "success" });
      onDone();
    } catch (caught) {
      setError(describirError(caught, "No fue posible anular el bloque."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Anular pago en bloque"
      description={resumen}
      size="sm"
      dismissible={!isSubmitting}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Se revierte el saldo de todas las facturas del bloque: vuelven a quedar Pendientes o Abonadas según lo que
          les falte. Si alguno de sus DOs está cerrado, no se anula nada.
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Motivo *</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            placeholder="Por qué se anula este pago en bloque…"
            className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-cyan-600"
          />
          <span className="text-[11px] text-slate-500">
            {motivo.trim().length}/{MOTIVO_MIN} caracteres mínimos
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
            onClick={onClose}
            disabled={isSubmitting}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !motivoValido}
            className="inline-flex h-10 items-center gap-2 bg-rose-700 px-4 text-sm font-semibold text-white transition hover:bg-rose-800 disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Anular bloque
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
