import { Suspense } from "react";

import { ArchivosClienteDetalleWorkspace } from "@/components/archivos/archivos-cliente-detalle-workspace";
import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ArchivosClienteDetallePage({ params }: PageProps) {
  const { id } = await params;
  await exigirAccesoPagina(`/archivos/clientes/${id}`);
  return (
    <Suspense
      fallback={<WorkspaceFallback titulo="Cliente" subtitulo="Sus DOs y documentos." filtros={0} tarjetas={0} />}
    >
      <ArchivosClienteDetalleWorkspace clienteId={id} />
    </Suspense>
  );
}
