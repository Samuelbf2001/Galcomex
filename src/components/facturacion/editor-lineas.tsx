"use client";

/**
 * Editor de líneas manuales de la factura de venta (flujo del socio Lucho).
 * Permite escribir ítems a mano y vincularlos N↔N a facturas de proveedor.
 * El total por líneas se muestra en vivo (BigInt) frente al total del motor (referencia).
 */

import { useEffect, useMemo, useState } from "react";

import {
  fetchFacturasProveedor,
  type FacturaProveedorRow,
} from "@/components/facturas-proveedor/facturas-proveedor-api";

import {
  actualizarLinea as apiActualizarLinea,
  crearLineaManual as apiCrearLinea,
  eliminarLinea as apiEliminarLinea,
  formatCOP,
  parseBigIntInput,
  type BorradorRow,
  type LineaRevisionRow,
} from "./facturacion-api";

type EditorLineasProps = {
  borrador: BorradorRow;
  tramiteId: string;
  puedeEditar: boolean;
  onBorradorActualizado: (borrador: BorradorRow) => void;
};

function sumaLineas(lineas: LineaRevisionRow[]): bigint {
  return lineas.reduce((acc, l) => {
    try {
      return acc + BigInt(l.valor);
    } catch {
      return acc;
    }
  }, 0n);
}

export function EditorLineas({
  borrador,
  tramiteId,
  puedeEditar,
  onBorradorActualizado,
}: EditorLineasProps) {
  const [facturas, setFacturas] = useState<FacturaProveedorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Estado del formulario de nueva línea
  const [nuevoConcepto, setNuevoConcepto] = useState("");
  const [nuevoNumSoporte, setNuevoNumSoporte] = useState("");
  const [nuevoValor, setNuevoValor] = useState("");
  const [nuevasFacturas, setNuevasFacturas] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetchFacturasProveedor(tramiteId, controller.signal)
      .then(setFacturas)
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Sin facturas no se bloquea la edición de líneas.
      });
    return () => controller.abort();
  }, [tramiteId]);

  const lineas = borrador.lineasRevision;

  const totalLineasVivo = useMemo(() => {
    try {
      return (
        sumaLineas(lineas) +
        BigInt(borrador.comision) +
        BigInt(borrador.ivaComision) -
        BigInt(borrador.retenciones)
      );
    } catch {
      return 0n;
    }
  }, [lineas, borrador.comision, borrador.ivaComision, borrador.retenciones]);

  const totalMotor = (() => {
    try {
      return BigInt(borrador.totalFactura);
    } catch {
      return 0n;
    }
  })();

  const desviacion = totalLineasVivo - totalMotor;

  async function ejecutar(accion: () => Promise<BorradorRow>) {
    setGuardando(true);
    setError(null);
    try {
      const actualizado = await accion();
      onBorradorActualizado(actualizado);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar la línea.");
    } finally {
      setGuardando(false);
    }
  }

  async function handleCrear() {
    const valor = parseBigIntInput(nuevoValor);
    if (!nuevoConcepto.trim() || !valor) {
      setError("Concepto y valor (positivo) son obligatorios.");
      return;
    }
    await ejecutar(() =>
      apiCrearLinea(borrador.id, {
        concepto: nuevoConcepto.trim(),
        numSoporte: nuevoNumSoporte.trim() || undefined,
        valor,
        facturaIds: nuevasFacturas,
      }),
    );
    setNuevoConcepto("");
    setNuevoNumSoporte("");
    setNuevoValor("");
    setNuevasFacturas([]);
  }

  function toggleNuevaFactura(id: string) {
    setNuevasFacturas((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function toggleFacturaLinea(linea: LineaRevisionRow, facturaId: string) {
    const next = linea.facturasVinculadas.includes(facturaId)
      ? linea.facturasVinculadas.filter((x) => x !== facturaId)
      : [...linea.facturasVinculadas, facturaId];
    await ejecutar(() =>
      apiActualizarLinea(borrador.id, linea.id, { facturaIds: next }),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-2 py-2">#</th>
            <th className="px-2 py-2">Concepto</th>
            <th className="px-2 py-2">N° soporte</th>
            <th className="px-2 py-2 text-right">Valor</th>
            <th className="px-2 py-2">Facturas de proveedor</th>
            <th className="px-2 py-2">Origen</th>
            {puedeEditar ? <th className="px-2 py-2" /> : null}
          </tr>
        </thead>
        <tbody>
          {lineas.map((linea) => (
            <tr key={linea.id} className="border-b border-slate-100 align-top">
              <td className="px-2 py-2 text-slate-400">{linea.orden}</td>
              <td className="px-2 py-2 font-medium text-slate-800">{linea.concepto}</td>
              <td className="px-2 py-2 font-mono text-slate-600">{linea.numSoporte ?? "—"}</td>
              <td className="px-2 py-2 text-right font-semibold text-slate-900">
                {formatCOP(linea.valor)}
              </td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-1">
                  {facturas.length === 0 ? (
                    <span className="text-xs text-slate-400">Sin facturas en el trámite</span>
                  ) : (
                    facturas.map((f) => {
                      const activa = linea.facturasVinculadas.includes(f.id);
                      return (
                        <button
                          key={f.id}
                          type="button"
                          disabled={!puedeEditar || guardando}
                          onClick={() => toggleFacturaLinea(linea, f.id)}
                          className={`border px-2 py-0.5 text-xs transition ${
                            activa
                              ? "border-cyan-300 bg-cyan-50 text-cyan-700"
                              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                          } ${!puedeEditar ? "cursor-default" : ""}`}
                          title={`${f.proveedorNombre} · ${formatCOP(f.valor)}`}
                        >
                          {f.numFactura}
                        </button>
                      );
                    })
                  )}
                </div>
              </td>
              <td className="px-2 py-2">
                <span
                  className={`border px-2 py-0.5 text-xs ${
                    linea.origen === "MANUAL"
                      ? "border-violet-200 bg-violet-50 text-violet-700"
                      : "border-slate-200 bg-slate-50 text-slate-500"
                  }`}
                >
                  {linea.origen === "MANUAL" ? "Manual" : "Auto"}
                </span>
              </td>
              {puedeEditar ? (
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    disabled={guardando}
                    onClick={() => ejecutar(() => apiEliminarLinea(borrador.id, linea.id))}
                    className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                  >
                    Eliminar
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
          {lineas.length === 0 ? (
            <tr>
              <td colSpan={puedeEditar ? 7 : 6} className="px-2 py-4 text-center text-slate-400">
                Sin líneas. Agrega los ítems de la factura abajo.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {puedeEditar ? (
        <div className="border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Nueva línea
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-slate-600">
              Concepto
              <input
                value={nuevoConcepto}
                onChange={(e) => setNuevoConcepto(e.target.value)}
                className="mt-1 w-56 border border-slate-300 px-2 py-1 text-sm"
                placeholder="Ej. Pago flete LUTOSA"
              />
            </label>
            <label className="flex flex-col text-xs text-slate-600">
              N° soporte
              <input
                value={nuevoNumSoporte}
                onChange={(e) => setNuevoNumSoporte(e.target.value)}
                className="mt-1 w-40 border border-slate-300 px-2 py-1 text-sm"
                placeholder="opcional"
              />
            </label>
            <label className="flex flex-col text-xs text-slate-600">
              Valor (COP)
              <input
                value={nuevoValor}
                onChange={(e) => setNuevoValor(e.target.value)}
                className="mt-1 w-36 border border-slate-300 px-2 py-1 text-right text-sm"
                placeholder="0"
                inputMode="numeric"
              />
            </label>
            <button
              type="button"
              disabled={guardando}
              onClick={handleCrear}
              className="border border-cyan-600 bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-cyan-700 disabled:opacity-50"
            >
              Agregar
            </button>
          </div>
          {facturas.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              <span className="mr-1 text-xs text-slate-500">Vincular facturas:</span>
              {facturas.map((f) => {
                const activa = nuevasFacturas.includes(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => toggleNuevaFactura(f.id)}
                    className={`border px-2 py-0.5 text-xs transition ${
                      activa
                        ? "border-cyan-300 bg-cyan-50 text-cyan-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                    }`}
                    title={`${f.proveedorNombre} · ${formatCOP(f.valor)}`}
                  >
                    {f.numFactura}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col items-end gap-1 border-t border-slate-200 pt-3 text-sm">
        <div className="flex w-full max-w-md justify-between">
          <span className="text-slate-500">Σ líneas + comisión + IVA − retenciones</span>
          <span className="font-bold text-slate-900">{formatCOP(totalLineasVivo.toString())}</span>
        </div>
        <div className="flex w-full max-w-md justify-between">
          <span className="text-slate-500">Total motor (referencia)</span>
          <span className="text-slate-600">{formatCOP(totalMotor.toString())}</span>
        </div>
        {desviacion !== 0n ? (
          <div className="flex w-full max-w-md justify-between border border-amber-200 bg-amber-50 px-2 py-1">
            <span className="font-medium text-amber-700">Desviación vs. motor</span>
            <span className="font-bold text-amber-700">{formatCOP(desviacion.toString())}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
