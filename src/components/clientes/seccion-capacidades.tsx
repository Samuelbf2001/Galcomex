"use client";

import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  fetchCapacidades,
  guardarCapacidades,
  type CapacidadRow,
  type ConfigCapacidad,
} from "@/components/clientes/capacidades-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mismo patrón que en clientes-workspace.tsx / tramite-detalle.tsx.
function useUserRol(): string {
  const [rol, setRol] = useState<string>("OPERATIVO");

  useEffect(() => {
    fetch("/api/auth/get-session", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (isRecord(data) && isRecord(data.user) && typeof data.user.rol === "string") {
          setRol(data.user.rol);
        }
      })
      .catch(() => {
        /* silencioso */
      });
  }, []);

  return rol;
}

const ETIQUETA_GRUPO: Record<string, string> = {
  Comercial: "Comercial",
  Operacion: "Operación",
  Facturacion: "Facturación",
  Cartera: "Cartera",
  Documentos: "Documentos",
};

/** Solo se editan configs planas de texto; el resto se muestra como JSON. */
function entradasEditables(config: ConfigCapacidad): [string, string][] {
  if (!config) return [];

  return Object.entries(config).filter(
    (entrada): entrada is [string, string] => typeof entrada[1] === "string",
  );
}

function Interruptor({
  activo,
  onToggle,
  disabled,
  etiqueta,
}: {
  activo: boolean;
  onToggle: () => void;
  disabled: boolean;
  etiqueta: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={etiqueta}
      disabled={disabled}
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${
        activo ? "border-emerald-600 bg-emerald-600" : "border-slate-300 bg-slate-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 bg-white transition ${
          activo ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function FilaCapacidad({
  capacidad,
  editable,
  guardando,
  onToggle,
  onHeredar,
  onConfig,
}: {
  capacidad: CapacidadRow;
  editable: boolean;
  guardando: boolean;
  onToggle: (capacidad: CapacidadRow) => void;
  onHeredar: (capacidad: CapacidadRow) => void;
  onConfig: (capacidad: CapacidadRow, clave: string, valor: string) => void;
}) {
  const editables = entradasEditables(capacidad.config);

  return (
    <div className="flex items-start gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0">
      <div className="pt-0.5">
        {guardando ? (
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden="true" />
        ) : (
          <Interruptor
            activo={capacidad.habilitado}
            disabled={!editable}
            onToggle={() => onToggle(capacidad)}
            etiqueta={capacidad.nombre}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-slate-900">{capacidad.nombre}</p>
          <code className="bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
            {capacidad.codigo}
          </code>
          {capacidad.tieneOverride ? (
            <span className="border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[11px] font-semibold text-cyan-700">
              Propio de la empresa
            </span>
          ) : (
            <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">
              {capacidad.origenHabilitado === "GRUPO" ? "Del grupo" : "Por defecto"}
            </span>
          )}
        </div>

        <p className="mt-1 text-sm text-slate-600">{capacidad.descripcion}</p>

        {capacidad.habilitado && editables.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-3">
            {editables.map(([clave, valor]) => (
              <label key={clave} className="flex items-center gap-2 text-xs text-slate-600">
                <span className="font-medium uppercase tracking-wide text-slate-500">
                  {clave}
                </span>
                <input
                  type="text"
                  defaultValue={valor}
                  disabled={!editable || guardando}
                  onBlur={(event) => {
                    if (event.target.value !== valor) {
                      onConfig(capacidad, clave, event.target.value);
                    }
                  }}
                  className="h-8 w-36 border border-slate-300 px-2 font-mono text-xs text-slate-900 disabled:bg-slate-50"
                />
              </label>
            ))}
          </div>
        ) : null}
      </div>

      {editable && capacidad.tieneOverride ? (
        <button
          type="button"
          onClick={() => onHeredar(capacidad)}
          disabled={guardando}
          title="Quitar el ajuste propio y volver a heredar"
          className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Heredar
        </button>
      ) : null}
    </div>
  );
}

/**
 * Interruptores de función de la empresa (M1 del PLAN-CONFIGURABILIDAD).
 * Aquí se activa o desactiva cada función general para esta empresa concreta,
 * en vez de ramificar el código por tipo de cliente.
 */
export function SeccionCapacidades({ clienteId }: { clienteId: string }) {
  const userRol = useUserRol();
  const editable = userRol === "ADMIN";

  const [capacidades, setCapacidades] = useState<CapacidadRow[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchCapacidades(clienteId, controller.signal)
      .then((filas) => {
        setCapacidades(filas);
        setCargando(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Error al cargar las funciones.");
        setCargando(false);
      });

    return () => controller.abort();
  }, [clienteId]);

  const aplicar = useCallback(
    async (
      capacidad: CapacidadRow,
      cambio: { heredar?: boolean; habilitado?: boolean; config?: ConfigCapacidad },
    ) => {
      setGuardando(capacidad.codigo);
      setError(null);

      try {
        const filas = await guardarCapacidades(clienteId, [
          { codigo: capacidad.codigo, ...cambio },
        ]);
        setCapacidades(filas);
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : "No fue posible guardar el cambio.");
      } finally {
        setGuardando(null);
      }
    },
    [clienteId],
  );

  const grupos = [...new Set(capacidades.map((capacidad) => capacidad.grupo))];
  const activas = capacidades.filter((capacidad) => capacidad.habilitado).length;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Funciones ({activas}/{capacidades.length} activas)
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Se activan o desactivan por empresa. Ninguna implica desarrollo a la medida.
          </p>
        </div>
        {!editable ? (
          <span className="text-xs text-slate-500">Solo lectura — requiere ADMIN</span>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {cargando ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">Cargando funciones…</p>
      ) : capacidades.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Sin catálogo de funciones. Corre el seed para sembrarlo.
        </p>
      ) : (
        grupos.map((grupo) => (
          <div key={grupo}>
            <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {ETIQUETA_GRUPO[grupo] ?? grupo}
            </p>
            {capacidades
              .filter((capacidad) => capacidad.grupo === grupo)
              .map((capacidad) => (
                <FilaCapacidad
                  key={capacidad.codigo}
                  capacidad={capacidad}
                  editable={editable}
                  guardando={guardando === capacidad.codigo}
                  onToggle={(fila) => void aplicar(fila, { habilitado: !fila.habilitado })}
                  onHeredar={(fila) => void aplicar(fila, { heredar: true })}
                  onConfig={(fila, clave, valor) =>
                    void aplicar(fila, {
                      habilitado: fila.habilitado,
                      config: { ...(fila.config ?? {}), [clave]: valor },
                    })
                  }
                />
              ))}
          </div>
        ))
      )}
    </div>
  );
}
