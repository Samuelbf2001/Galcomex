"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

/**
 * Barra de paginación reutilizable para tablas/listados.
 *
 *   <Paginacion total={169} pagina={pagina} porPagina={porPagina}
 *     onPaginaChange={setPagina} onPorPaginaChange={setPorPagina} etiqueta="trámites" />
 *
 * Para listados que ya están completos en memoria, `usePaginacionLocal`
 * evita repetir el estado y el `slice`:
 *
 *   const { visibles, ...pag } = usePaginacionLocal(filas);
 *   <Paginacion total={pag.total} pagina={pag.pagina} porPagina={pag.porPagina}
 *     onPaginaChange={pag.setPagina} onPorPaginaChange={pag.setPorPagina} />
 */

type PaginacionProps = {
  total: number;
  /** 1-based */
  pagina: number;
  porPagina: number;
  onPaginaChange: (pagina: number) => void;
  onPorPaginaChange: (porPagina: number) => void;
  opciones?: number[];
  /** Ej. "trámites" -> "Mostrando 1–25 de 169 trámites". */
  etiqueta?: string;
  cargando?: boolean;
};

const OPCIONES_DEFECTO = [25, 50, 100];

export function Paginacion({
  total,
  pagina,
  porPagina,
  onPaginaChange,
  onPorPaginaChange,
  opciones = OPCIONES_DEFECTO,
  etiqueta,
  cargando = false,
}: PaginacionProps) {
  const selectId = useId();
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaActual = Math.min(Math.max(pagina, 1), totalPaginas);
  const desde = total === 0 ? 0 : (paginaActual - 1) * porPagina + 1;
  const hasta = total === 0 ? 0 : Math.min(paginaActual * porPagina, total);
  const sufijo = etiqueta ? ` ${etiqueta}` : "";

  function cambiarPorPagina(valor: number) {
    // Cambiar el tamaño de página siempre vuelve a la página 1: el rango
    // visible cambia por completo y "quedarse" en la página N ya no tiene sentido.
    onPorPaginaChange(valor);
    onPaginaChange(1);
  }

  return (
    <nav
      aria-label="Paginación"
      className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between"
    >
      <p aria-live="polite">
        {total === 0 ? "Sin resultados" : `Mostrando ${desde}–${hasta} de ${total}${sufijo}`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={selectId} className="flex items-center gap-2">
          <span className="text-slate-500">Por página</span>
          <select
            id={selectId}
            value={porPagina}
            disabled={cargando}
            onChange={(event) => cambiarPorPagina(Number(event.target.value))}
            className="h-10 border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:opacity-60"
          >
            {opciones.map((opcion) => (
              <option key={opcion} value={opcion}>
                {opcion}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPaginaChange(paginaActual - 1)}
            disabled={cargando || paginaActual <= 1}
            aria-label="Página anterior"
            className="inline-flex min-h-11 items-center gap-1 border border-slate-300 bg-white px-3 font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Anterior
          </button>
          <span className="px-2 text-slate-500">
            Página {paginaActual} de {totalPaginas}
          </span>
          <button
            type="button"
            onClick={() => onPaginaChange(paginaActual + 1)}
            disabled={cargando || paginaActual >= totalPaginas}
            aria-label="Página siguiente"
            className="inline-flex min-h-11 items-center gap-1 border border-slate-300 bg-white px-3 font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Siguiente
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  );
}

/**
 * Pagina en memoria un arreglo ya cargado (sin ir al servidor). `pagina` que
 * devuelve siempre queda dentro de rango aunque `items` se encoja (filtro
 * que deja menos resultados que la página actual).
 */
export function usePaginacionLocal<T>(items: T[], porPaginaInicial = 25) {
  const [pagina, setPaginaState] = useState(1);
  const [porPagina, setPorPaginaState] = useState(porPaginaInicial);

  const total = items.length;
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaEfectiva = Math.min(Math.max(pagina, 1), totalPaginas);

  const setPagina = useCallback((p: number) => setPaginaState(Math.max(1, p)), []);
  const setPorPagina = useCallback((n: number) => {
    setPorPaginaState(n);
    setPaginaState(1);
  }, []);

  const visibles = useMemo(() => {
    const inicio = (paginaEfectiva - 1) * porPagina;
    return items.slice(inicio, inicio + porPagina);
  }, [items, paginaEfectiva, porPagina]);

  return { pagina: paginaEfectiva, porPagina, setPagina, setPorPagina, visibles, total };
}
