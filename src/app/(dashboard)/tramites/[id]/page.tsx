import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { TramiteDetalle } from "@/components/tramites/tramite-detalle";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function TramiteDetallePage({ params }: Props) {
  const { id } = await params;

  return (
    <section className="space-y-5">
      {/* Cabecera */}
      <div className="flex items-center gap-3">
        <Link
          href="/tramites"
          className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-50"
          aria-label="Volver a tramites"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Detalle del tramite</h1>
          <p className="mt-0.5 text-sm text-slate-600">
            Resumen, documentos, pagos, facturación e historial del DO.
          </p>
        </div>
      </div>

      {/* Componente cliente con pestañas */}
      <TramiteDetalle tramiteId={id} />
    </section>
  );
}
