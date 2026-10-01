"use client";

import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchPagoGrupo, formatCOP, formatDate, type PagoRealizadoJson } from "@/components/pagos/pagos-global-api";
import { formatInstanteBogota } from "@/lib/tiempo/bogota";
import { ModuleState } from "@/components/layout/module-state";
import { EnlaceTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError } from "@/components/ui/toast";

const CANAL_LABEL: Record<string, string> = {
  TRANSF_BANCOLOMBIA: "Transf. Bancolombia",
  PSE: "PSE",
  TRANSF_OTROS_BANCOS: "Transf. Otros Bancos",
};

const COSTO_ASUMIDO_LABEL: Record<string, string> = {
  GALCOMEX: "lo asume Galcomex",
  PRIMER_DO: "lo asume el primer DO que se pudo cobrar",
  PRORRATEADO: "repartido entre los DOs que pudieron absorberlo",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `GET /api/tramites/[tramiteId]/documentos/[id]` reimplementado localmente
 * (mismo patrón que `subirComprobante` en `pagos-api.ts`, para no acoplar
 * este archivo — de P4 — a `documentos-api.ts`, fuera de este paquete):
 * pide la URL firmada de descarga y la abre en una pestaña nueva.
 */
async function abrirComprobante(tramiteId: string, documentoId: string): Promise<void> {
  const response = await fetch(`/api/tramites/${tramiteId}/documentos/${documentoId}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || typeof payload.url !== "string") {
    throw new Error("No fue posible abrir el comprobante.");
  }
  window.open(payload.url, "_blank", "noopener,noreferrer");
}

export type DetalleBloqueDialogProps = {
  grupoPagoId: string;
  onClose: () => void;
};

/**
 * Detalle de un pago en bloque (CxP v2, §D.1 "Pagos realizados", clic en la
 * fila): por DO y por factura, con montos ("FE 12602 · abono $100.000"),
 * costo bancario y a quién se asignó, comprobante y estado (activo / anulado
 * con motivo / registro histórico).
 */
export function DetalleBloqueDialog({ grupoPagoId, onClose }: DetalleBloqueDialogProps) {
  const [grupo, setGrupo] = useState<PagoRealizadoJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [abriendoComprobante, setAbriendoComprobante] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchPagoGrupo(grupoPagoId, controller.signal)
      .then(setGrupo)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(describirError(caught, "No fue posible cargar el detalle del bloque."));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [grupoPagoId, reloadKey]);

  async function handleAbrirComprobante() {
    if (!grupo?.comprobante || abriendoComprobante) return;
    setAbriendoComprobante(true);
    try {
      await abrirComprobante(grupo.comprobante.tramiteId, grupo.comprobante.documentoId);
    } catch (caught) {
      setError(describirError(caught, "No fue posible abrir el comprobante."));
    } finally {
      setAbriendoComprobante(false);
    }
  }

  return (
    <ModalShell open onClose={onClose} title="Detalle del pago en bloque" size="lg">
      {loading ? (
        <div className="flex items-center justify-center py-10 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        </div>
      ) : error ? (
        <ModuleState
          type="error"
          title="No se pudo cargar el detalle"
          detail={error}
          action={{
            label: "Reintentar",
            onClick: () => {
              setError(null);
              setLoading(true);
              setReloadKey((k) => k + 1);
            },
          }}
        />
      ) : grupo ? (
        <div className="space-y-4">
          {grupo.estado === "ANULADO" && grupo.anulacion ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Anulado el {formatInstanteBogota(grupo.anulacion.en)}
              {grupo.anulacion.por ? ` por ${grupo.anulacion.por}` : ""}: {grupo.anulacion.motivo}
            </div>
          ) : grupo.esHistorico ? (
            <div className="border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Registro histórico (Excel de cartera).
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">Fecha</dt>
              <dd className="font-medium text-slate-800">{formatDate(grupo.fecha) || "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Valor</dt>
              <dd className="font-medium text-slate-800">{formatCOP(grupo.valor)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Canal</dt>
              <dd className="font-medium text-slate-800">{CANAL_LABEL[grupo.canalPago] ?? grupo.canalPago}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Costo de la transferencia</dt>
              <dd className="font-medium text-slate-800">
                {formatCOP(grupo.costoBancario)}
                {BigInt(grupo.costoBancario || "0") > 0n && grupo.costoAsumidoPor
                  ? ` · ${COSTO_ASUMIDO_LABEL[grupo.costoAsumidoPor] ?? grupo.costoAsumidoPor}`
                  : ""}
              </dd>
            </div>
          </dl>

          {grupo.concepto ? (
            <p className="text-sm text-slate-600">
              <span className="text-slate-500">Concepto: </span>
              {grupo.concepto}
            </p>
          ) : null}

          {grupo.comprobante ? (
            <button
              type="button"
              onClick={() => void handleAbrirComprobante()}
              disabled={abriendoComprobante}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-cyan-700 hover:underline disabled:opacity-60"
            >
              {abriendoComprobante ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Ver comprobante
            </button>
          ) : (
            <p className="text-sm text-amber-600">Sin comprobante bancario.</p>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">DOs cubiertos</h3>
            <div className="divide-y divide-slate-100 border border-slate-200">
              {grupo.dos.map((d) => (
                <div key={d.tramiteId} className="flex items-center justify-between px-3 py-2 text-sm">
                  <EnlaceTramite id={d.tramiteId} tab="facturas-proveedor" className="font-semibold text-slate-800">
                    {d.consecutivo}
                  </EnlaceTramite>
                  <span className="font-medium text-slate-600">{formatCOP(d.valor)}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Facturas cubiertas</h3>
            <div className="divide-y divide-slate-100 border border-slate-200">
              {grupo.facturas.map((f) => (
                <div key={f.facturaId} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-700">{f.numFactura}</span>
                  <span className="font-medium text-slate-600">{formatCOP(f.monto)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}
