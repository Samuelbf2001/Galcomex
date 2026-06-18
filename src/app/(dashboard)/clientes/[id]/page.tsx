import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ClienteDetallePage as ClienteDetalleWorkspace } from "@/components/clientes/cliente-detalle";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ClienteDetallePage({ params }: Props) {
  const { id } = await params;

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/clientes"
          className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-50"
          aria-label="Volver a clientes"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Ficha del cliente</h1>
          <p className="mt-0.5 text-sm text-slate-600">
            Datos, tarifas, tramites, anticipos y facturas relacionados.
          </p>
        </div>
      </div>

      <ClienteDetalleWorkspace clienteId={id} />
    </section>
  );
}
