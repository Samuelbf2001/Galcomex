/**
 * Skeletons que reservan espacio mientras llegan los datos (evitan el salto
 * de contenido que hoy produce el spinner sin altura).
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`motion-safe:animate-pulse rounded bg-slate-200/80 ${className}`}
      aria-hidden="true"
    />
  );
}

type TableSkeletonProps = {
  rows?: number;
  cols?: number;
  /** Altura aproximada de fila en px; por defecto 44. */
  rowHeight?: number;
};

/** Tabla fantasma con el mismo alto que la tabla real (≈ 44 px por fila). */
export function TableSkeleton({ rows = 6, cols = 5, rowHeight = 44 }: TableSkeletonProps) {
  return (
    <div
      className="w-full overflow-hidden rounded-xl border border-slate-200 bg-white"
      role="status"
      aria-live="polite"
      aria-label="Cargando datos"
    >
      <div className="flex gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-4 border-b border-slate-100 px-4 last:border-b-0"
          style={{ height: rowHeight }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-3 flex-1 ${c === 0 ? "max-w-[30%]" : ""}`} />
          ))}
        </div>
      ))}
      <span className="sr-only">Cargando…</span>
    </div>
  );
}

/** Tarjetas KPI fantasma (dashboard, cabeceras de ficha). */
export function CardsSkeleton({ count = 4, height = 120 }: { count?: number; height?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="border border-slate-200 bg-white p-4" style={{ height }}>
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="mt-4 h-7 w-1/3" />
          <Skeleton className="mt-3 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
