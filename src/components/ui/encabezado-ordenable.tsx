"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Encabezado de columna ordenable para tablas server-side paginadas.
 *
 *   <EncabezadoOrdenable campo="apertura" tipo="fecha" ordenActual={orden} onOrdenar={setOrden}>
 *     Apertura
 *   </EncabezadoOrdenable>
 *
 * Un <th> con un botón (objetivo táctil de 44px), `aria-sort` y el indicador
 * ▲/▼/⇅. El primer clic en una columna nueva usa la dirección de `tipo`
 * ("fecha" empieza en descendente — lo más reciente primero; "texto" empieza
 * en ascendente — A→Z); los siguientes clics alternan asc/desc. El componente
 * solo calcula el próximo `{ campo, direccion }` y se lo pasa a `onOrdenar`:
 * el llamador decide qué hacer con él (guardarlo y volver a la página 1).
 */

export type DireccionOrden = "asc" | "desc";

export type OrdenActual<Campo extends string = string> =
  | { campo: Campo; direccion: DireccionOrden }
  | null;

type EncabezadoOrdenableProps<Campo extends string = string> = {
  campo: Campo;
  children: ReactNode;
  ordenActual: OrdenActual<Campo>;
  onOrdenar: (orden: { campo: Campo; direccion: DireccionOrden }) => void;
  /** Dirección del primer clic sobre esta columna. Por defecto "texto" (asc). */
  tipo?: "texto" | "fecha";
  className?: string;
};

export function EncabezadoOrdenable<Campo extends string = string>({
  campo,
  children,
  ordenActual,
  onOrdenar,
  tipo = "texto",
  className,
}: EncabezadoOrdenableProps<Campo>) {
  const activo = ordenActual?.campo === campo;
  const direccion = activo ? ordenActual.direccion : null;

  function handleClick() {
    const siguiente: DireccionOrden = !activo
      ? tipo === "fecha"
        ? "desc"
        : "asc"
      : direccion === "asc"
        ? "desc"
        : "asc";
    onOrdenar({ campo, direccion: siguiente });
  }

  const Icono = !activo ? ArrowUpDown : direccion === "asc" ? ArrowUp : ArrowDown;
  const ariaSort: "ascending" | "descending" | "none" = !activo
    ? "none"
    : direccion === "asc"
      ? "ascending"
      : "descending";

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`border-b border-slate-200 p-0${className ? ` ${className}` : ""}`}
    >
      <button
        type="button"
        onClick={handleClick}
        className={`flex h-11 min-h-11 w-full items-center gap-1 whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wide transition hover:bg-slate-100 hover:text-slate-800 ${
          activo ? "text-slate-800" : "text-slate-500"
        }`}
      >
        {children}
        <Icono className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
    </th>
  );
}
