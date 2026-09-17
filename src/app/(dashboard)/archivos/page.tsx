import { Suspense } from "react";

import { ArchivosWorkspace } from "@/components/archivos/archivos-workspace";
import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function ArchivosPage() {
  await exigirAccesoPagina("/archivos");
  return (
    <Suspense
      fallback={
        <WorkspaceFallback
          titulo="Archivos"
          subtitulo="Explorador del almacenamiento de documentos, carpeta por carpeta."
          filtros={2}
          tarjetas={0}
        />
      }
    >
      <ArchivosWorkspace />
    </Suspense>
  );
}
