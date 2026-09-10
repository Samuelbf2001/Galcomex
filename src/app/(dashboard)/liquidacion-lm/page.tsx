import { Suspense } from "react";

import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { LiquidacionWorkspace } from "@/components/liquidacion-lm/liquidacion-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function LiquidacionLMPage() {
  await exigirAccesoPagina("/liquidacion-lm");
  return (
    <Suspense
      fallback={
        <WorkspaceFallback
          titulo="Liquidación LM"
          subtitulo="Cuenta corriente con el socio Lucho: neteo del saldo de cruce de los trámites facturados en el período."
          filtros={3}
          tarjetas={3}
        />
      }
    >
      <LiquidacionWorkspace />
    </Suspense>
  );
}
