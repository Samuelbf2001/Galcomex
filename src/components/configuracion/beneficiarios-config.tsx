"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchBeneficiarios,
  updateBeneficiario,
  type BeneficiarioRow,
} from "@/components/beneficiarios/beneficiario-api";

type EditState = {
  id: string;
  field: "nit" | "nombre";
  value: string;
};

export function BeneficiariosConfig() {
  const [beneficiarios, setBeneficiarios] = useState<BeneficiarioRow[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null); // id en guardado
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async (signal?: AbortSignal) => {
    setCargando(true);
    setError(null);
    try {
      const rows = await fetchBeneficiarios(undefined, signal);
      setBeneficiarios(rows);
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setError("No fue posible cargar los beneficiarios.");
      }
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void cargar(ctrl.signal);
    return () => ctrl.abort();
  }, [cargar]);

  useEffect(() => {
    if (edit) inputRef.current?.focus();
  }, [edit]);

  function iniciarEdicion(id: string, field: "nit" | "nombre", valorActual: string | null) {
    setEdit({ id, field, value: valorActual ?? "" });
    setErrorGuardado(null);
  }

  function cancelarEdicion() {
    setEdit(null);
    setErrorGuardado(null);
  }

  async function guardar() {
    if (!edit) return;
    setGuardando(edit.id);
    setErrorGuardado(null);
    try {
      const updated = await updateBeneficiario(edit.id, {
        [edit.field]: edit.value.trim() || null,
      });
      setBeneficiarios((prev) =>
        prev.map((b) => (b.id === updated.id ? updated : b)),
      );
      setEdit(null);
    } catch (e) {
      setErrorGuardado(
        e instanceof Error ? e.message : "Error al guardar.",
      );
    } finally {
      setGuardando(null);
    }
  }

  const sinNit = beneficiarios.filter((b) => !b.nit).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Beneficiarios / Proveedores</h2>
          <p className="text-xs text-slate-500">
            NIT requerido para generar facturas electrónicas en Siigo.
          </p>
        </div>
        {sinNit > 0 && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            {sinNit} sin NIT
          </span>
        )}
      </div>

      {cargando && (
        <p className="text-sm text-slate-500">Cargando beneficiarios…</p>
      )}
      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
      {errorGuardado && (
        <p className="text-sm text-red-600">{errorGuardado}</p>
      )}

      {!cargando && !error && (
        <div className="overflow-hidden border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-2">NIT</th>
                <th className="border-b border-slate-200 px-4 py-2">Banco</th>
              </tr>
            </thead>
            <tbody>
              {beneficiarios.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-center text-slate-400">
                    No hay beneficiarios registrados.
                  </td>
                </tr>
              )}
              {beneficiarios.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  {/* Nombre */}
                  <td className="px-4 py-2">
                    {edit?.id === b.id && edit.field === "nombre" ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={inputRef}
                          value={edit.value}
                          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void guardar();
                            if (e.key === "Escape") cancelarEdicion();
                          }}
                          className="w-48 rounded border border-slate-300 px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                        <button
                          onClick={() => void guardar()}
                          disabled={guardando === b.id}
                          className="text-xs font-medium text-blue-600 disabled:opacity-50"
                        >
                          Guardar
                        </button>
                        <button
                          onClick={cancelarEdicion}
                          className="text-xs text-slate-400"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => iniciarEdicion(b.id, "nombre", b.nombre)}
                        className="text-left hover:underline"
                        title="Editar nombre"
                      >
                        {b.nombre}
                      </button>
                    )}
                  </td>

                  {/* NIT */}
                  <td className="px-4 py-2">
                    {edit?.id === b.id && edit.field === "nit" ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={inputRef}
                          value={edit.value}
                          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void guardar();
                            if (e.key === "Escape") cancelarEdicion();
                          }}
                          placeholder="900123456-7"
                          className="w-36 rounded border border-slate-300 px-2 py-0.5 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                        <button
                          onClick={() => void guardar()}
                          disabled={guardando === b.id}
                          className="text-xs font-medium text-blue-600 disabled:opacity-50"
                        >
                          Guardar
                        </button>
                        <button
                          onClick={cancelarEdicion}
                          className="text-xs text-slate-400"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => iniciarEdicion(b.id, "nit", b.nit)}
                        className={`font-mono text-sm ${
                          b.nit
                            ? "text-slate-700 hover:underline"
                            : "text-amber-600 hover:underline"
                        }`}
                        title="Editar NIT"
                      >
                        {b.nit ?? "— Sin NIT —"}
                      </button>
                    )}
                  </td>

                  {/* Banco */}
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {b.banco ?? "—"}
                    {b.numCuenta ? ` · ${b.numCuenta}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
