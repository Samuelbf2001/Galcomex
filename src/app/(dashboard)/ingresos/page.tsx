import { Suspense } from "react";

import { IngresosWorkspace } from "@/components/ingresos/ingresos-workspace";
import { ModuleState } from "@/components/layout/module-state";

export default function IngresosPage() {
  return (
    <Suspense fallback={<ModuleState type="loading" title="Cargando ingresos…" />}>
      <IngresosWorkspace />
    </Suspense>
  );
}
