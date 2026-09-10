import { Suspense } from "react";

import { CarteraWorkspace } from "@/components/cartera/cartera-workspace";
import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function CarteraPage() {
  await exigirAccesoPagina("/cartera");
  return (
    <Suspense
      fallback={
        <WorkspaceFallback
          titulo="Cartera"
          subtitulo="Relación de facturas, abonos, devoluciones y estados de cuenta por cliente."
          filtros={4}
        />
      }
    >
      <CarteraWorkspace />
    </Suspense>
  );
}
