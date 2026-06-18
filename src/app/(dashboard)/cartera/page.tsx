import { Suspense } from "react";

import { CarteraWorkspace } from "@/components/cartera/cartera-workspace";
import { ModuleState } from "@/components/layout/module-state";

export default function CarteraPage() {
  return (
    <Suspense fallback={<ModuleState type="loading" title="Cargando cartera…" />}>
      <CarteraWorkspace />
    </Suspense>
  );
}
