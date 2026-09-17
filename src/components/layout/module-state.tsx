"use client";

import { AlertTriangle, Inbox, Loader2, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

type ModuleStateAction = {
  label: string;
  onClick: () => void;
  /** Muestra el icono de recargar (por defecto true para errores). */
  icon?: boolean;
};

type ModuleStateProps = {
  type: "loading" | "error" | "empty";
  title: string;
  detail?: string;
  /** Botón de acción: "Reintentar" en errores, CTA en vacíos. */
  action?: ModuleStateAction;
  children?: ReactNode;
};

/**
 * Estado de módulo (cargando / error / vacío). El error y el vacío ya no
 * comparten icono ni color, y ambos aceptan una acción.
 */
export function ModuleState({ type, title, detail, action, children }: ModuleStateProps) {
  const Icon = type === "loading" ? Loader2 : type === "error" ? AlertTriangle : Inbox;
  const tone =
    type === "error"
      ? "border-rose-200 bg-rose-50/60 text-rose-900"
      : "border-slate-200 bg-white text-slate-600";
  const iconTone = type === "error" ? "text-rose-600" : "text-slate-500";

  return (
    <div
      className={`flex min-h-44 flex-col justify-center gap-4 rounded-xl border px-5 py-6 text-sm shadow-sm ${tone}`}
      role={type === "error" ? "alert" : "status"}
      aria-atomic="true"
      aria-busy={type === "loading" ? true : undefined}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 h-5 w-5 shrink-0 ${iconTone} ${type === "loading" ? "motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className={`font-medium ${type === "error" ? "text-rose-900" : "text-slate-900"}`}>{title}</p>
          {detail ? <p className="mt-1 max-w-prose break-words leading-relaxed">{detail}</p> : null}
          {children}
        </div>
      </div>
      {action ? (
        <div className="pl-8">
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            {(action.icon ?? type === "error") ? (
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            ) : null}
            {action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
