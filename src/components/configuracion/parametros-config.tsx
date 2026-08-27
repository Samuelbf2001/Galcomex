"use client";

import { useState } from "react";

export type ParametroRow = {
  id: string;
  clave: string;
  valor: string;
  descripcion: string | null;
};

/**
 * Tabla de Parametro genéricos del sistema. Solo lectura para roles
 * distintos de ADMIN (igual que antes). ADMIN puede editar el valor inline.
 *
 * Los parámetros SIIGO_* no llegan aquí — la página de Configuración ya los
 * excluye (se editan desde SiigoParametros).
 */
export function ParametrosConfig({
  parametros: parametrosIniciales,
  esAdmin,
}: {
  parametros: ParametroRow[];
  esAdmin: boolean;
}) {
  const [parametros, setParametros] = useState(parametrosIniciales);
  const [editando, setEditando] = useState<string | null>(null);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function abrir(p: ParametroRow) {
    setEditando(p.clave);
    setValor(p.valor);
    setError(null);
  }

  function cerrar() {
    setEditando(null);
    setValor("");
    setError(null);
  }

  async function guardar(clave: string) {
    setError(null);
    const trimmed = valor.trim();
    if (trimmed.length === 0) {
      setError("El valor no puede estar vacío");
      return;
    }

    setGuardando(true);
    const res = await fetch(`/api/parametros/${encodeURIComponent(clave)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ valor: trimmed }),
    });
    setGuardando(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "No fue posible guardar el parámetro");
      return;
    }

    setParametros((prev) =>
      prev.map((p) => (p.clave === clave ? { ...p, valor: trimmed } : p)),
    );
    cerrar();
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Parámetros del sistema</h2>
        <p className="text-sm text-slate-600">
          Tasas y valores por defecto usados por el motor de cálculo.
        </p>
      </div>
      <div className="overflow-hidden border border-slate-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="border-b border-slate-200 px-4 py-3">Clave</th>
              <th className="border-b border-slate-200 px-4 py-3">Valor</th>
              <th className="border-b border-slate-200 px-4 py-3">Descripción</th>
              {esAdmin ? (
                <th className="border-b border-slate-200 px-4 py-3 text-right">
                  Acción
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {parametros.map((parametro) => (
              <tr key={parametro.id} className="border-b border-slate-100 align-top">
                <td className="px-4 py-3 font-mono text-xs">{parametro.clave}</td>
                <td className="px-4 py-3">
                  {esAdmin && editando === parametro.clave ? (
                    <div className="flex flex-col gap-1">
                      <input
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                        autoFocus
                        className="h-8 w-48 border border-slate-300 px-2 text-sm outline-none focus:border-cyan-600"
                      />
                      {error ? (
                        <span className="text-xs text-red-600">{error}</span>
                      ) : null}
                    </div>
                  ) : (
                    parametro.valor
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {parametro.descripcion}
                </td>
                {esAdmin ? (
                  <td className="px-4 py-3 text-right">
                    {editando === parametro.clave ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={cerrar}
                          className="h-8 border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-100"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => void guardar(parametro.clave)}
                          disabled={guardando}
                          className="h-8 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {guardando ? "Guardando" : "Guardar"}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => abrir(parametro)}
                        className="inline-flex h-8 items-center gap-1.5 border border-slate-300 px-3 text-xs text-slate-700 hover:bg-slate-100"
                      >
                        Editar
                      </button>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
