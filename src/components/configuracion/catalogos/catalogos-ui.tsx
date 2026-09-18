"use client";

/**
 * Piezas visuales compartidas por las pestañas de Configuración → Catálogos
 * (Conceptos, Eventos, Productos↔impuestos). Mismas clases que ya usan
 * `seccion-tarifario.tsx` y `seccion-capacidades.tsx` para que la pantalla no
 * se sienta distinta al resto de Configuración.
 */

export const INPUT =
  "h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-cyan-600 disabled:bg-slate-50";
export const TEXTAREA =
  "w-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-cyan-600 disabled:bg-slate-50";
export const LABEL = "text-xs font-medium text-slate-600";
export const BTN =
  "inline-flex h-9 items-center gap-1.5 border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_PRIMARIO = `${BTN} border-slate-950 bg-slate-950 text-white hover:bg-slate-800`;
export const BTN_SECUNDARIO = `${BTN} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;

export function BadgeActivo({ activo }: { activo: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
        activo ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}
    >
      {activo ? "Activo" : "Inactivo"}
    </span>
  );
}

export function BadgeCodigo({ codigo }: { codigo: string }) {
  return (
    <span
      className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
      title="Código fijo: no se puede cambiar."
    >
      {codigo}
    </span>
  );
}

/** Interruptor accesible (role="switch"), igual al de `seccion-capacidades.tsx`. */
export function Interruptor({
  activo,
  onToggle,
  disabled,
  etiqueta,
}: {
  activo: boolean;
  onToggle: () => void;
  disabled?: boolean;
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
