"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConciliarLoteModal } from "@/components/cartera/conciliar-lote-modal";
import type {
  ConciliarLoteResponse,
  FacturaRow,
} from "@/components/cartera/cartera-api";
import { ModuleState } from "@/components/layout/module-state";

import {
  fetchLiquidacionLM,
  formatCOP,
  formatDate,
  LiquidacionApiError,
  type LiquidacionData,
  type LiquidacionTramiteRow,
} from "./liquidacion-api";

// ─── Helpers visuales ─────────────────────────────────────────────────────────

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

function safeBigInt(v: string): bigint {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * Convierte un LiquidacionTramiteRow al shape mínimo que necesita
 * ConciliarLoteModal con destino="LM". Solo se usan: id, saldoNetoLM,
 * borrador.tramite.consecutivo, numSiigo.
 */
function toLoteFacturaRow(t: LiquidacionTramiteRow): FacturaRow {
  const saldoLMBig = safeBigInt(t.saldoLM);
  return {
    id: t.facturaId,
    borradorId: t.borradorId,
    clienteId: "",
    numSiigo: t.numFacturaSiigo ?? "—",
    fecha: t.fechaFactura ?? "",
    totalFactura: "0",
    saldoAFavorCliente: "0",
    saldoACargoCliente: "0",
    saldoAFavorLM: "0",
    saldoACargoLM: "0",
    fechaPagoCliente: null,
    fechaPagoLM: null,
    createdAt: "",
    updatedAt: "",
    borrador: {
      tramiteId: t.tramiteId,
      tramite: { consecutivo: t.consecutivo },
    },
    saldoNetoCliente: "0",
    pendienteCobroCliente: "0",
    pendienteDevolucionCliente: "0",
    saldoNetoLM: t.saldoLM,
    pendienteCobroLM: saldoLMBig < 0n ? (-saldoLMBig).toString() : "0",
    pendienteDevolucionLM: saldoLMBig > 0n ? t.saldoLM : "0",
    costosBancariosCliente: "0",
    costosBancariosLM: "0",
    totalRealLM: "0",
    pagos: [],
  };
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function LiquidacionWorkspace() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [data, setData] = useState<LiquidacionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtro pendientes
  const [soloPendientes, setSoloPendientes] = useState(false);

  // Selección batch
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loteModalOpen, setLoteModalOpen] = useState(false);

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

  const aplicarFiltro = () => {
    setSelectedIds(new Set());
    cargar(desde, hasta);
  };

  const limpiarFiltro = () => {
    setDesde("");
    setHasta("");
    setSelectedIds(new Set());
    cargar("", "");
  };

  const tramites = useMemo(() => data?.tramites ?? [], [data]);

  const isElegible = useCallback(
    (t: LiquidacionTramiteRow) => safeBigInt(t.saldoLM) !== 0n,
    [],
  );

  const tramitesVisibles = useMemo(
    () => (soloPendientes ? tramites.filter(isElegible) : tramites),
    [tramites, soloPendientes, isElegible],
  );

  const elegibles = useMemo(
    () => tramitesVisibles.filter(isElegible),
    [tramitesVisibles, isElegible],
  );

  const allElegiblesSelected = useMemo(
    () =>
      elegibles.length > 0 && elegibles.every((t) => selectedIds.has(t.facturaId)),
    [elegibles, selectedIds],
  );

  const pendienteTotalSeleccionado = useMemo(() => {
    let total = 0n;
    for (const t of tramitesVisibles) {
      if (!selectedIds.has(t.facturaId)) continue;
      const v = safeBigInt(t.saldoLM);
      total += v < 0n ? -v : v;
    }
    return total;
  }, [tramitesVisibles, selectedIds]);

  const toggleRow = useCallback((facturaId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(facturaId)) next.delete(facturaId);
      else next.add(facturaId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (elegibles.length > 0 && elegibles.every((t) => prev.has(t.facturaId))) {
        return new Set();
      }
      return new Set(elegibles.map((t) => t.facturaId));
    });
  }, [elegibles]);

  // Poda automática: quita ids que ya no están en la lista visible
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(tramitesVisibles.map((t) => t.facturaId));
      const filtered = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [tramitesVisibles]);

  const facturasSeleccionadas = useMemo(
    () =>
      tramitesVisibles
        .filter((t) => selectedIds.has(t.facturaId))
        .map(toLoteFacturaRow),
    [tramitesVisibles, selectedIds],
  );

  function handleLoteCompletado(result: ConciliarLoteResponse) {
    const okIds = new Set(
      result.results.filter((r) => r.ok).map((r) => r.facturaId),
    );
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => !okIds.has(id)));
      return next;
    });
    setLoteModalOpen(false);
    setSelectedIds(new Set());
    cargar(desde, hasta);
  }

  return (
    <>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-slate-900">Liquidación LM</h1>
          <p className="text-sm text-slate-600">
            Cuenta corriente con el socio Lucho. Netea el saldo de cruce de los
            trámites SOCIO_LM facturados en el período para saldar en un solo pago.
          </p>
        </header>

        {/* Filtros */}
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
              onClick={limpiarFiltro}
              className="h-9 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Limpiar
            </button>
          )}

          <div className="flex flex-col gap-1 ml-auto">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Trámites
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => { setSoloPendientes(false); setSelectedIds(new Set()); }}
                className={`h-9 border px-3 text-xs font-semibold transition ${
                  !soloPendientes
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Todos
              </button>
              <button
                type="button"
                onClick={() => { setSoloPendientes(true); setSelectedIds(new Set()); }}
                className={`h-9 border px-3 text-xs font-semibold transition ${
                  soloPendientes
                    ? "border-amber-600 bg-amber-600 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Pendientes por saldar
              </button>
            </div>
          </div>
        </div>

        {loading ? (
          <ModuleState type="loading" title="Cargando liquidación…" />
        ) : error ? (
          <ModuleState type="error" title="No se pudo cargar" detail={error} />
        ) : !data || tramites.length === 0 ? (
          <ModuleState
            type="empty"
            title="Sin trámites para liquidar"
            detail="No hay trámites SOCIO_LM facturados en el período seleccionado."
          />
        ) : (
          <>
            {/* Cards resumen */}
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
                <div className="mt-3">
                  {safeBigInt(data.resumen.saldoNeto) === 0n ? (
                    <span className="inline-flex items-center border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      Cruzado y pagado
                    </span>
                  ) : (
                    <span className="inline-flex items-center border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                      Saldo cruzado · pendiente de saldar
                    </span>
                  )}
                </div>
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

            {/* Tabla */}
            <div className="overflow-hidden border border-slate-200 bg-white">
              {/* Bulk actions bar */}
              {selectedIds.size > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2.5">
                  <div className="text-xs text-indigo-900">
                    <span className="font-semibold">{selectedIds.size}</span>{" "}
                    trámite{selectedIds.size !== 1 ? "s" : ""} seleccionado
                    {selectedIds.size !== 1 ? "s" : ""} · Pendiente total LM:{" "}
                    <span className="font-semibold">
                      {formatCOP(pendienteTotalSeleccionado.toString())}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      className="h-8 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    >
                      Limpiar selección
                    </button>
                    <button
                      type="button"
                      onClick={() => setLoteModalOpen(true)}
                      className="h-8 border border-indigo-700 bg-indigo-700 px-3 text-xs font-semibold text-white transition hover:bg-indigo-800"
                    >
                      Conciliar {selectedIds.size} trámite
                      {selectedIds.size !== 1 ? "s" : ""}
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={allElegiblesSelected}
                          disabled={elegibles.length === 0}
                          onChange={toggleAll}
                          aria-label="Seleccionar todos los elegibles"
                          className="h-4 w-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-30"
                        />
                      </th>
                      <th className="px-4 py-3 font-medium">Trámite</th>
                      <th className="px-4 py-3 font-medium">Cliente</th>
                      <th className="px-4 py-3 font-medium">Factura Siigo</th>
                      <th className="px-4 py-3 font-medium">Fecha</th>
                      <th className="px-4 py-3 text-right font-medium">Saldo interno LM</th>
                      <th className="px-4 py-3 text-right font-medium">Saldo a favor cliente</th>
                      <th className="px-4 py-3 text-right font-medium">Saldo LM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tramitesVisibles.map((t) => {
                      const cruzado = safeBigInt(t.saldoLM) === 0n;
                      const eligible = !cruzado;
                      const selected = selectedIds.has(t.facturaId);
                      return (
                        <tr
                          key={t.borradorId}
                          className={`border-b border-slate-100 last:border-0 transition-colors ${
                            cruzado
                              ? "bg-slate-50/50 text-slate-400"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!eligible}
                              onChange={() => toggleRow(t.facturaId)}
                              aria-label="Seleccionar trámite"
                              className="h-4 w-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-30"
                            />
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-900">
                            <Link
                              href={`/tramites/${t.tramiteId}`}
                              className="text-cyan-700 hover:underline"
                            >
                              {t.consecutivo}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {t.clienteNombre || "—"}
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
                          <td className="px-4 py-3 text-right">
                            {cruzado ? (
                              <span className="inline-flex items-center border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                Cruzado
                              </span>
                            ) : (
                              <span
                                className={`font-medium tabular-nums ${montoClass(t.saldoLM)}`}
                              >
                                {formatCOP(t.saldoLM)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                      <td className="px-3 py-3" />
                      <td className="px-4 py-3 text-slate-900" colSpan={6}>
                        Saldo neto ({tramitesVisibles.length} trámite{tramitesVisibles.length !== 1 ? "s" : ""}{soloPendientes ? " pendientes" : ""})
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
            </div>
          </>
        )}
      </div>

      {/* Modal conciliación batch */}
      {loteModalOpen && facturasSeleccionadas.length > 0 ? (
        <ConciliarLoteModal
          facturas={facturasSeleccionadas}
          destino="LM"
          onClose={() => setLoteModalOpen(false)}
          onCompletado={handleLoteCompletado}
        />
      ) : null}
    </>
  );
}
