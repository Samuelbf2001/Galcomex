"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";

import { patchJson } from "@/components/configuracion/respuesta-api";
import { ModuleState } from "@/components/layout/module-state";
import { describirError, useToast } from "@/components/ui/toast";

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
  const { toast } = useToast();
  const errorId = useId();
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
    if (guardando) return;
    setError(null);
    const trimmed = valor.trim();
    if (trimmed.length === 0) {
      setError("El valor no puede estar vacío");
      return;
    }

    setGuardando(true);
    try {
      await patchJson(
        `/api/parametros/${encodeURIComponent(clave)}`,
        { valor: trimmed },
        "No fue posible guardar el parámetro",
      );
      setParametros((prev) =>
        prev.map((p) => (p.clave === clave ? { ...p, valor: trimmed } : p)),
      );
      toast({ title: "Parámetro guardado", description: `${clave} = ${trimmed}`, variant: "success" });
      cerrar();
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible guardar el parámetro");
      setError(mensaje);
      toast({ title: "No se pudo guardar el parámetro", description: mensaje, variant: "error" });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Parámetros del sistema</h2>
        <p className="text-sm text-slate-600">
          Tasas y valores por defecto usados por el motor de cálculo.
          {esAdmin && " Pulsa un valor para editar; Enter guarda y Escape cancela."}
        </p>
      </div>
      {parametros.length === 0 && <ModuleState type="empty" title="No hay parámetros configurados" detail="Los parámetros disponibles aparecerán aquí cuando se configure el sistema." />}
      <div className="overflow-x-auto border border-slate-200 bg-white">
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void guardar(parametro.clave);
                          if (e.key === "Escape") cerrar();
                        }}
                        autoFocus
                        disabled={guardando}
                        aria-label={`Valor de ${parametro.clave}`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        className={`h-8 w-48 border px-2 text-sm outline-none focus:border-cyan-600 ${
                          error ? "border-rose-500" : "border-slate-300"
                        }`}
                      />
                      {error ? (
                        <span id={errorId} role="alert" className="text-xs text-red-600">
                          {error}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    esAdmin ? <button type="button" disabled={editando !== null} onClick={() => abrir(parametro)} aria-label={`Editar valor de ${parametro.clave}`} className="min-h-10 rounded border border-dashed border-slate-300 px-3 text-left font-medium text-cyan-800 hover:border-cyan-500 hover:bg-cyan-50 disabled:opacity-60">{parametro.valor}</button> : parametro.valor
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
                          disabled={guardando}
                          className="h-8 border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => void guardar(parametro.clave)}
                          disabled={guardando}
                          className="inline-flex h-8 items-center gap-1.5 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {guardando ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : null}
                          {guardando ? "Guardando…" : "Guardar"}
                        </button>
                      </div>
                    ) : null}
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
