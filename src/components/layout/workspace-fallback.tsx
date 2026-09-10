import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";

type WorkspaceFallbackProps = {
  /** Título visible mientras hidrata (mantiene el h1 en su sitio). */
  titulo: string;
  subtitulo?: string;
  /** Número de controles de la barra de filtros a reservar. */
  filtros?: number;
  tarjetas?: number;
};

/**
 * Fallback de Suspense con la MISMA silueta que el workspace real (título,
 * barra de filtros, tarjetas y tabla). Evita el salto de contenido que
 * producía el bloque genérico "Cargando…" al ser sustituido por la vista.
 */
export function WorkspaceFallback({ titulo, subtitulo, filtros = 4, tarjetas = 0 }: WorkspaceFallbackProps) {
  return (
    <section className="space-y-5" aria-busy="true" aria-label={`Cargando ${titulo}`}>
      <div>
        <h1 className="text-2xl font-semibold">{titulo}</h1>
        {subtitulo ? <p className="mt-1 text-sm text-slate-600">{subtitulo}</p> : <Skeleton className="mt-2 h-4 w-80 max-w-full" />}
      </div>
      <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white px-4 py-3">
        {Array.from({ length: filtros }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-9 w-44" />
          </div>
        ))}
      </div>
      {tarjetas > 0 ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${tarjetas}, minmax(0, 1fr))` }}>
          {Array.from({ length: tarjetas }).map((_, i) => (
            <div key={i} className="border border-slate-200 bg-white p-4" style={{ height: 96 }}>
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="mt-4 h-6 w-1/3" />
            </div>
          ))}
        </div>
      ) : null}
      <TableSkeleton rows={6} cols={6} />
    </section>
  );
}
