"use client";

/**
 * Pago por lote — un desembolso que cubre facturas de varios DOs.
 *
 * Es el flujo de Karina (reunión 1-jul, min 00:48–00:50): elige el cliente, ve
 * TODAS sus facturas pendientes con el DO del que vienen, marca las que entran
 * en el pago del día, adjunta un solo comprobante y guarda. El sistema crea por
 * detrás un pago por cada trámite involucrado, así que los saldos por DO siguen
 * cuadrando; ella nunca tiene que pensar en eso.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { formatCOP } from "@/components/pagos/pagos-api";
import type { ClienteOption } from "@/components/pagos/pagos-global-api";

const CANALES: { value: string; label: string }[] = [
  { value: "TRANSF_BANCOLOMBIA", label: "Transferencia Bancolombia" },
  { value: "PSE", label: "PSE" },
  { value: "TRANSF_OTROS_BANCOS", label: "Transferencia otros bancos" },
];

type FacturaImpaga = {
  id: string;
  numFactura: string;
  valor: string;
  fecha: string;
  proveedorNombre: string;
  tramite: { id: string; consecutivo: string };
};

type Props = {
  clientes: ClienteOption[];
  onClose: () => void;
  onCreated: () => void;
};

function hoyInput(): string {
  return new Date().toISOString().slice(0, 10);
}

export function LotePagoModal({ clientes, onClose, onCreated }: Props) {
  const [clienteId, setClienteId] = useState("");
  const [facturas, setFacturas] = useState<FacturaImpaga[]>([]);
  const [cargando, setCargando] = useState(false);
  const [seleccion, setSeleccion] = useState<Record<string, string>>({});
  const [fechaPago, setFechaPago] = useState(hoyInput());
  const [canalPago, setCanalPago] = useState(CANALES[0]?.value ?? "TRANSF_BANCOLOMBIA");
  const [referencia, setReferencia] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Limpiar al cambiar de cliente se hace en el propio manejador del select
  // (ver `handleClienteChange`), no aquí: llamar setState en el cuerpo de un
  // efecto dispara renders en cascada.
  useEffect(() => {
    if (!clienteId) return;

    const controller = new AbortController();

    fetch(`/api/clientes/${clienteId}/facturas-impagas`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("No se pudieron cargar las facturas del cliente.");
        const data = (await r.json()) as { facturas: FacturaImpaga[] };
        setFacturas(data.facturas ?? []);
        setSeleccion({});
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Error cargando facturas.");
      })
      .finally(() => setCargando(false));

    return () => controller.abort();
  }, [clienteId]);

  /**
   * Cambiar de cliente descarta la selección: las facturas ya no son las
   * mismas. El estado de carga también se marca aquí, no dentro del efecto —
   * seleccionar cliente es el único camino que dispara la búsqueda, y hacerlo
   * en un manejador de evento evita los renders en cascada de llamar setState
   * en el cuerpo de un `useEffect`.
   */
  const handleClienteChange = useCallback((nuevoClienteId: string) => {
    setClienteId(nuevoClienteId);
    setFacturas([]);
    setSeleccion({});
    setError(null);
    setCargando(Boolean(nuevoClienteId));
  }, []);

  const toggleFactura = useCallback((factura: FacturaImpaga) => {
    setSeleccion((prev) => {
      const next = { ...prev };
      if (next[factura.id] !== undefined) {
        delete next[factura.id];
      } else {
        // Por defecto se paga el valor completo de la factura; el operario lo
        // ajusta si el banco cobró otra cosa.
        next[factura.id] = factura.valor;
      }
      return next;
    });
  }, []);

  const seleccionadas = useMemo(
    () => facturas.filter((f) => seleccion[f.id] !== undefined),
    [facturas, seleccion],
  );

  const total = useMemo(() => {
    return seleccionadas.reduce((acc, f) => {
      const raw = seleccion[f.id] ?? "0";
      const limpio = raw.replace(/\D/g, "");
      return acc + (limpio ? BigInt(limpio) : 0n);
    }, 0n);
  }, [seleccionadas, seleccion]);

  const tramitesAfectados = useMemo(
    () => new Set(seleccionadas.map((f) => f.tramite.id)).size,
    [seleccionadas],
  );

  async function handleSubmit() {
    if (seleccionadas.length === 0) {
      setError("Selecciona al menos una factura.");
      return;
    }

    setEnviando(true);
    setError(null);

    try {
      const response = await fetch("/api/lotes-pago", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fechaPago: new Date(`${fechaPago}T00:00:00.000Z`).toISOString(),
          canalPago,
          referencia: referencia.trim() || null,
          facturas: seleccionadas.map((f) => ({
            facturaProveedorId: f.id,
            valor: (seleccion[f.id] ?? "0").replace(/\D/g, "") || "0",
          })),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "No se pudo registrar el lote de pago.");
      }

      onCreated();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Error registrando el lote.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl">
        <header className="border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Pago por lote</h2>
          <p className="mt-1 text-sm text-slate-500">
            Un solo desembolso que cubre facturas de varios trámites. Se registra un pago
            por cada trámite, con el mismo comprobante.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Cliente *</span>
              <select
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                value={clienteId}
                onChange={(e) => handleClienteChange(e.target.value)}
              >
                <option value="">Selecciona un cliente…</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Fecha del pago *</span>
              <input
                type="date"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                value={fechaPago}
                onChange={(e) => setFechaPago(e.target.value)}
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Canal *</span>
              <select
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                value={canalPago}
                onChange={(e) => setCanalPago(e.target.value)}
              >
                {CANALES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">
                Referencia del banco
              </span>
              <input
                type="text"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                placeholder="Nro. de operación del extracto"
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
              />
            </label>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold text-slate-800">
              Facturas pendientes del cliente
            </h3>

            {!clienteId ? (
              <p className="mt-2 text-sm text-slate-500">
                Selecciona un cliente para ver sus facturas pendientes.
              </p>
            ) : cargando ? (
              <p className="mt-2 text-sm text-slate-500">Cargando facturas…</p>
            ) : facturas.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                Este cliente no tiene facturas pendientes de pago.
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto rounded border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Incluir</th>
                      <th className="px-3 py-2 text-left">Trámite</th>
                      <th className="px-3 py-2 text-left">Factura</th>
                      <th className="px-3 py-2 text-left">Proveedor</th>
                      <th className="px-3 py-2 text-right">Valor</th>
                      <th className="px-3 py-2 text-right">Se paga</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facturas.map((f) => {
                      const marcada = seleccion[f.id] !== undefined;
                      return (
                        <tr key={f.id} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={marcada}
                              onChange={() => toggleFactura(f)}
                              aria-label={`Incluir factura ${f.numFactura}`}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-slate-600">
                            {f.tramite.consecutivo}
                          </td>
                          <td className="px-3 py-2">{f.numFactura}</td>
                          <td className="px-3 py-2 text-slate-600">{f.proveedorNombre}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatCOP(f.valor)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="text"
                              inputMode="numeric"
                              disabled={!marcada}
                              className="w-32 rounded border border-slate-300 px-2 py-1 text-right text-sm disabled:bg-slate-50"
                              value={seleccion[f.id] ?? ""}
                              onChange={(e) =>
                                setSeleccion((prev) => ({
                                  ...prev,
                                  [f.id]: e.target.value.replace(/\D/g, ""),
                                }))
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {seleccionadas.length > 0 ? (
            <p className="mt-4 rounded bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {seleccionadas.length}{" "}
              {seleccionadas.length === 1 ? "factura" : "facturas"} de{" "}
              <strong>
                {tramitesAfectados} {tramitesAfectados === 1 ? "trámite" : "trámites"}
              </strong>
              . Total del desembolso:{" "}
              <strong className="tabular-nums">{formatCOP(total.toString())}</strong>
            </p>
          ) : null}

          {error ? (
            <p className="mt-4 rounded bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-3 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={enviando || seleccionadas.length === 0}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {enviando ? "Registrando…" : "Registrar lote"}
          </button>
        </footer>
      </div>
    </div>
  );
}
