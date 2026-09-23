import { Suspense } from "react";

import { ArchivosClientesWorkspace } from "@/components/archivos/archivos-clientes-workspace";
import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function ArchivosClientesPage() {
  await exigirAccesoPagina("/archivos/clientes");
  return (
    <Suspense
      fallback={
        <WorkspaceFallback
          titulo="Archivos · Por cliente"
          subtitulo="Cada cliente con sus DOs y documentos."
          filtros={1}
          tarjetas={0}
        />
      }
    >
      <ArchivosClientesWorkspace />
    </Suspense>
  );
}
