"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";

import {
  fetchLiquidacionLM,
  formatCOP,
  formatDate,
  LiquidacionApiError,
  type LiquidacionData,
} from "./liquidacion-api";

function montoClass(value: string): string {
  try {
    const n = BigInt(value);
    if (n < 0n) return "text-rose-600";
    if (n > 0n) return "text-emerald-600";
  } catch {
    // ignore
  }
  return "text-slate-700";
}

function direccionNeto(value: string): { texto: string; clase: string } {
  try {
    const n = BigInt(value);
    if (n < 0n) {
      return { texto: "Lucho le debe a Galcomex", clase: "text-rose-600" };
    }
    if (n > 0n) {
      return { texto: "Galcomex le debe a Lucho", clase: "text-emerald-600" };
    }
  } catch {
    // ignore
  }
  return { texto: "Cuenta saldada", clase: "text-slate-600" };
}

export function LiquidacionWorkspace() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [data, setData] = useState<LiquidacionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback((d: string, h: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    fetchLiquidacionLM(d || undefined, h || undefined, signal)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const msg =
          err instanceof LiquidacionApiError
            ? err.message
            : "Error al cargar la liquidación.";
        setError(msg);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    // Carga inicial (sin filtro). El setState ocurre en callbacks async,
    // nunca de forma síncrona dentro del effect.
    const controller = new AbortController();
    fetchLiquidacionLM(undefined, undefined, controller.signal)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          err instanceof LiquidacionApiError
            ? err.message
            : "Error al cargar la liquidación.",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const aplicarFiltro = () => cargar(desde, hasta);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Liquidación LM</h1>
        <p className="text-sm text-slate-600">
          Cuenta corriente con el socio Lucho. Netea el saldo de cruce de los
          trámites SOCIO_LM facturados en el período para saldar en un solo pago.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Desde (fecha factura)
          <input
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="h-9 rounded-md border border-slate-300 px-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Hasta (fecha factura)
          <input
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="h-9 rounded-md border border-slate-300 px-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={aplicarFiltro}
          className="h-9 rounded-md bg-slate-900 px-4 text-sm font-medium text-white transition hover:bg-slate-700"
        >
          Aplicar
        </button>
        {(desde || hasta) && (
          <button
            type="button"
            onClick={() => {
              setDesde("");
              setHasta("");
              cargar("", "");
            }}
            className="h-9 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Limpiar
          </button>
        )}
      </div>

      {loading ? (
        <ModuleState type="loading" title="Cargando liquidación…" />
      ) : error ? (
        <ModuleState type="error" title="No se pudo cargar" detail={error} />
      ) : !data || data.tramites.length === 0 ? (
        <ModuleState
          type="empty"
          title="Sin trámites para liquidar"
          detail="No hay trámites SOCIO_LM facturados en el período seleccionado."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="border border-slate-200 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Saldo neto a liquidar
              </p>
              <p
                className={`mt-1 text-2xl font-semibold ${direccionNeto(data.resumen.saldoNeto).clase}`}
              >
                {formatCOP(data.resumen.saldoNeto)}
              </p>
              <p className={`mt-1 text-sm ${direccionNeto(data.resumen.saldoNeto).clase}`}>
                {direccionNeto(data.resumen.saldoNeto).texto}
              </p>
            </div>
            <div className="border border-slate-200 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Lucho debe a Galcomex
              </p>
              <p className="mt-1 text-2xl font-semibold text-rose-600">
                {formatCOP(data.resumen.totalLuchoDebe)}
              </p>
            </div>
            <div className="border border-slate-200 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Galcomex debe a Lucho
              </p>
              <p className="mt-1 text-2xl font-semibold text-emerald-600">
                {formatCOP(data.resumen.totalGalcomexDebe)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Trámite</th>
                  <th className="px-4 py-3 font-medium">Factura Siigo</th>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 text-right font-medium">Saldo interno LM</th>
                  <th className="px-4 py-3 text-right font-medium">Saldo a favor cliente</th>
                  <th className="px-4 py-3 text-right font-medium">Saldo LM</th>
                </tr>
              </thead>
              <tbody>
                {data.tramites.map((t) => (
                  <tr
                    key={t.borradorId}
                    className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <Link
                        href={`/tramites/${t.tramiteId}`}
                        className="text-cyan-700 hover:underline"
                      >
                        {t.consecutivo}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {t.numFacturaSiigo ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {formatDate(t.fechaFactura)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {formatCOP(t.saldoLMInterno)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {formatCOP(t.saldoAFavorCliente)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-medium tabular-nums ${montoClass(t.saldoLM)}`}
                    >
                      {formatCOP(t.saldoLM)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <td className="px-4 py-3 text-slate-900" colSpan={5}>
                    Saldo neto ({data.resumen.cantidad} trámites)
                  </td>
                  <td
                    className={`px-4 py-3 text-right tabular-nums ${montoClass(data.resumen.saldoNeto)}`}
                  >
                    {formatCOP(data.resumen.saldoNeto)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
