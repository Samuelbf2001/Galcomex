"use client";

/**
 * Re-expresión del valor en pesos de una factura en dólares (D-4, §B.4, §D.3).
 * Solo ADMIN. Reemplaza el `ajuste-factura-modal.tsx` de v1.0 (D-8: ya no hay
 * "Saldar diferencia"): si la TRM cambió entre que se registró la factura y
 * el momento de pagar, el ADMIN corrige el valor en pesos con motivo auditado,
 * nunca por debajo de lo ya pagado y nunca si ya se le cobró al cliente.
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin } from "@/lib/auth/rol-context";
import { copDesdeUsd, formatoCentavos, formatoPesos } from "@/lib/cxp/saldos";
import { fechaCalendarioAInput, formatFechaCalendario, hoyBogotaISO } from "@/lib/tiempo/bogota";

import {
  FacturasProveedorApiError,
  formatCOP,
  parseBigIntInput,
  reexpresarFacturaUsd,
  type FacturaProveedorRow,
} from "@/components/facturas-proveedor/facturas-proveedor-api";

const MOTIVO_MIN = 10;

export type ReexpresarUsdModalProps = {
  factura: FacturaProveedorRow;
  onClose: () => void;
  onReexpresada: (factura: FacturaProveedorRow) => void;
};

function centavosDeTexto(raw: string): bigint | null {
  const limpio = raw.replace(/\./g, "").replace(",", ".").trim();
  if (!limpio) return null;
  const n = Number(limpio);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 100));
}

export function ReexpresarUsdModal({ factura, onClose, onReexpresada }: ReexpresarUsdModalProps) {
  const esAdmin = useEsAdmin();
  const { toast } = useToast();

  const [trmRaw, setTrmRaw] = useState(
    factura.trm ? formatoCentavos(BigInt(factura.trm)).replace(",", ".") : "",
  );
  const [valorRaw, setValorRaw] = useState(factura.valor);
  const [fechaTrm, setFechaTrm] = useState(
    factura.fechaTrm ? fechaCalendarioAInput(factura.fechaTrm) : hoyBogotaISO(),
  );
  const [motivo, setMotivo] = useState("");
  const [confirmarValorUsd, setConfirmarValorUsd] = useState(false);
  const [avisoUsd, setAvisoUsd] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!esAdmin) return null;
  if (factura.moneda !== "USD" || !factura.valorOrigen) {
    return null;
  }

  const valorOrigenCentavos = BigInt(factura.valorOrigen);
  const trmCentavos = centavosDeTexto(trmRaw);
  const sugerido = trmCentavos !== null ? copDesdeUsd(valorOrigenCentavos, trmCentavos) : null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setAvisoUsd(null);

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig) {
      setError("El valor en pesos debe ser un número entero mayor a 0.");
      return;
    }
    if (trmCentavos === null || trmCentavos <= 0n) {
      setError("La TRM debe ser mayor a 0 (ej. 3.710,50).");
      return;
    }
    if (motivo.trim().length < MOTIVO_MIN) {
      setError(`Escribe el motivo (al menos ${MOTIVO_MIN} caracteres).`);
      return;
    }

    setSubmitting(true);
    try {
      const actualizada = await reexpresarFacturaUsd(factura.id, {
        valor: valorBig,
        trmCentavos: trmCentavos.toString(),
        fechaTrm: fechaTrm || null,
        motivo: motivo.trim(),
        confirmarValorUsd,
      });
      toast({
        title: "Factura re-expresada",
        description: `${factura.numFacturaVisible} · ${formatCOP(actualizada.valor)}`,
        variant: "success",
      });
      onReexpresada(actualizada);
    } catch (caught) {
      if (
        caught instanceof FacturasProveedorApiError &&
        caught.codigo === "USD_VALOR_LEJOS_DE_TRM"
      ) {
        setAvisoUsd(caught.message);
        setConfirmarValorUsd(true);
        return;
      }
      setError(describirError(caught, "Error al re-expresar la factura."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Re-expresar en pesos"
      description={`${factura.numFacturaVisible} · Valor actual ${formatCOP(factura.valor)} (TRM ${formatFechaCalendario(factura.fechaTrm, "corta")})`}
      size="sm"
      dismissible={!submitting}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Usa esta opción cuando la TRM cambió entre que se registró la factura y el momento de
          pagar. Nunca queda por debajo de lo ya pagado, y no aplica si la factura ya se le cobró
          al cliente.
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">
            USD {factura.valorOrigen ? formatoCentavos(BigInt(factura.valorOrigen)) : "—"}
          </span>
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Nueva TRM *</span>
          <input
            value={trmRaw}
            onChange={(e) => setTrmRaw(e.target.value)}
            placeholder="3.710,50"
            className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Fecha de la TRM</span>
          <input
            type="date"
            value={fechaTrm}
            onChange={(e) => setFechaTrm(e.target.value)}
            className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        {sugerido !== null ? (
          <p className="text-xs text-slate-500">
            Con esa TRM da <span className="font-semibold text-slate-700">{formatoPesos(sugerido)}</span>
          </p>
        ) : null}

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Nuevo valor en pesos *</span>
          <input
            value={valorRaw}
            onChange={(e) => {
              setValorRaw(e.target.value);
              setConfirmarValorUsd(false);
              setAvisoUsd(null);
            }}
            placeholder="486.076"
            className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Motivo *</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            placeholder="Por qué se re-expresa esta factura…"
            className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-cyan-600"
          />
          <span className="text-[11px] text-slate-500">
            {motivo.trim().length}/{MOTIVO_MIN} caracteres mínimos
          </span>
        </label>

        {avisoUsd ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p>{avisoUsd}</p>
              <p className="mt-1 text-xs">Vuelve a guardar para confirmar el valor.</p>
            </div>
          </div>
        ) : null}

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
            disabled={submitting}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {avisoUsd ? "Sí, guardar" : "Re-expresar"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
