import { Suspense } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { LiquidacionWorkspace } from "@/components/liquidacion-lm/liquidacion-workspace";

export default function LiquidacionLMPage() {
  return (
    <Suspense fallback={<ModuleState type="loading" title="Cargando liquidación…" />}>
      <LiquidacionWorkspace />
    </Suspense>
  );
}
