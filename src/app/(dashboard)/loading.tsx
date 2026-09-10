import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Pantalla de carga de cualquier ruta del dashboard: se muestra al instante
 * al hacer clic en el menú, mientras el servidor resuelve la página.
 */
export default function DashboardLoading() {
  return (
    <section className="space-y-5" aria-busy="true" aria-label="Cargando módulo">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <TableSkeleton rows={7} cols={6} />
    </section>
  );
}
