"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useId, useMemo, useRef } from "react";

import { useNumeroUrl } from "@/components/ui/estado-url";

/**
 * Barra de paginación reutilizable para tablas/listados.
 *
 *   <Paginacion total={169} pagina={pagina} porPagina={porPagina}
 *     onPaginaChange={setPagina} onPorPaginaChange={setPorPagina} etiqueta="trámites" />
 *
 * Para listados que ya están completos en memoria, `usePaginacionLocal`
 * evita repetir el estado y el `slice`:
 *
 *   const { visibles, ...pag } = usePaginacionLocal(filas, 25, { pagina: "pagina" });
 *   <Paginacion total={pag.total} pagina={pag.pagina} porPagina={pag.porPagina}
 *     onPaginaChange={pag.setPagina} onPorPaginaChange={pag.setPorPagina} />
 *
 * Siempre en el mismo sitio (debajo de la tabla) y con la misma forma en todo
 * el sistema: rango visible, tamaño de página, números de página para saltar
 * directo y Anterior/Siguiente. Al cambiar de página la tabla vuelve a verse
 * desde su primera fila.
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

/**
 * Páginas a mostrar como botones: todas si son pocas; si no, la primera, la
 * última y las vecinas de la actual, con «…» en los saltos.
 *   paginasVisibles(5, 13) → [1, "…", 4, 5, 6, "…", 13]
 */
export function paginasVisibles(actual: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const desde = Math.max(2, Math.min(actual - 1, total - 4));
  const hasta = Math.min(total - 1, Math.max(actual + 1, 5));
  const paginas: (number | "…")[] = [1];
  if (desde > 2) paginas.push("…");
  for (let p = desde; p <= hasta; p++) paginas.push(p);
  if (hasta < total - 1) paginas.push("…");
  paginas.push(total);
  return paginas;
}

const BOTON =
  "inline-flex min-h-10 items-center justify-center border border-slate-300 bg-white text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

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
  const navRef = useRef<HTMLElement>(null);
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaActual = Math.min(Math.max(pagina, 1), totalPaginas);
  const desde = total === 0 ? 0 : (paginaActual - 1) * porPagina + 1;
  const hasta = total === 0 ? 0 : Math.min(paginaActual * porPagina, total);
  const sufijo = etiqueta ? ` ${etiqueta}` : "";

  // Al cambiar de página, si el inicio de la tabla quedó arriba (fuera de la
  // vista), se lleva a la vista: la página nueva se lee desde su primera fila.
  function irA(destino: number) {
    onPaginaChange(destino);
    const bloque = navRef.current?.parentElement;
    if (bloque && bloque.getBoundingClientRect().top < 80) {
      bloque.scrollIntoView?.({ block: "start" });
    }
  }

  function cambiarPorPagina(valor: number) {
    // Cambiar el tamaño de página siempre vuelve a la página 1: el rango
    // visible cambia por completo y "quedarse" en la página N ya no tiene sentido.
    onPorPaginaChange(valor);
    onPaginaChange(1);
  }

  return (
    <nav
      ref={navRef}
      aria-label="Paginación"
      className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600 md:flex-row md:items-center md:justify-between"
    >
      <p aria-live="polite" className="tabular-nums">
        {total === 0 ? "Sin resultados" : `Mostrando ${desde}–${hasta} de ${total}${sufijo}`}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={selectId} className="flex items-center gap-2">
          <span className="text-slate-600">Por página</span>
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
            onClick={() => irA(paginaActual - 1)}
            disabled={cargando || paginaActual <= 1}
            aria-label="Página anterior"
            className={`${BOTON} gap-1 px-3`}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Anterior
          </button>
          {/* Números: en pantallas pequeñas se ve solo «Página X de Y». */}
          <ol className="hidden items-center gap-1 sm:flex">
            {paginasVisibles(paginaActual, totalPaginas).map((p, i) =>
              p === "…" ? (
                <li key={`salto-${i}`} aria-hidden="true" className="w-6 text-center text-slate-500">
                  …
                </li>
              ) : (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => irA(p)}
                    disabled={cargando}
                    aria-label={`Página ${p}`}
                    aria-current={p === paginaActual ? "page" : undefined}
                    className={
                      p === paginaActual
                        ? "inline-flex min-h-10 min-w-10 items-center justify-center border border-slate-950 bg-slate-950 px-2 text-sm font-semibold tabular-nums text-white"
                        : `${BOTON} min-w-10 px-2 tabular-nums`
                    }
                  >
                    {p}
                  </button>
                </li>
              ),
            )}
          </ol>
          <span className="px-2 text-slate-600 sm:sr-only">
            Página {paginaActual} de {totalPaginas}
          </span>
          <button
            type="button"
            onClick={() => irA(paginaActual + 1)}
            disabled={cargando || paginaActual >= totalPaginas}
            aria-label="Página siguiente"
            className={`${BOTON} gap-1 px-3`}
          >
            Siguiente
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  );
}

/** Nombres de los parámetros de la URL donde se recuerda la página (opcional). */
export type PaginacionEnUrl = {
  /** Parámetro de la página, p. ej. "pagina" o "pagCartera". */
  pagina: string;
  /** Parámetro del tamaño de página; por defecto `${pagina}Tam`. */
  porPagina?: string;
};

/**
 * Pagina en memoria un arreglo ya cargado (sin ir al servidor). `pagina` que
 * devuelve siempre queda dentro de rango aunque `items` se encoja (filtro
 * que deja menos resultados que la página actual).
 *
 * Con `enUrl`, la página y el tamaño se recuerdan en la dirección: al abrir un
 * detalle y volver con «atrás», el listado sigue donde estaba.
 */
export function usePaginacionLocal<T>(items: T[], porPaginaInicial = 25, enUrl?: PaginacionEnUrl) {
  const [pagina, setPaginaState] = useNumeroUrl(enUrl?.pagina ?? null, 1);
  const [porPagina, setPorPaginaState] = useNumeroUrl(
    enUrl ? (enUrl.porPagina ?? `${enUrl.pagina}Tam`) : null,
    porPaginaInicial,
  );

  const total = items.length;
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaEfectiva = Math.min(Math.max(pagina, 1), totalPaginas);

  const setPagina = useCallback((p: number) => setPaginaState(Math.max(1, p)), [setPaginaState]);
  const setPorPagina = useCallback(
    (n: number) => {
      setPorPaginaState(n);
      setPaginaState(1);
    },
    [setPaginaState, setPorPaginaState],
  );

  const visibles = useMemo(() => {
    const inicio = (paginaEfectiva - 1) * porPagina;
    return items.slice(inicio, inicio + porPagina);
  }, [items, paginaEfectiva, porPagina]);

  return { pagina: paginaEfectiva, porPagina, setPagina, setPorPagina, visibles, total };
}
