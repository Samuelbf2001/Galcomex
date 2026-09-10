import { Suspense } from "react";

import { IngresosWorkspace } from "@/components/ingresos/ingresos-workspace";
import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function IngresosPage() {
  await exigirAccesoPagina("/ingresos");
  return (
    <Suspense
      fallback={
        <WorkspaceFallback
          titulo="Ingresos"
          subtitulo="Libro de bancos unificado: anticipos, abonos de factura y devoluciones."
          filtros={3}
          tarjetas={3}
        />
      }
    >
      <IngresosWorkspace />
    </Suspense>
  );
}
