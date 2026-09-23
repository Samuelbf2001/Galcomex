import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ClienteDetallePage as ClienteDetalleWorkspace } from "@/components/clientes/cliente-detalle";
import { parsearAbrirPopup } from "@/components/clientes/clientes-api";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

type Props = {
  params: Promise<{ id: string }>;
  /** `?abrir=tarifas|funciones|contacto` — deep link a un pop-up de la ficha. */
  searchParams: Promise<{ abrir?: string | string[] }>;
};

export default async function ClienteDetallePage({ params, searchParams }: Props) {
  const { id } = await params;
  await exigirAccesoPagina(`/clientes/${id}`);
  const { abrir } = await searchParams;
  const abrirInicial = parsearAbrirPopup(abrir);

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

      <ClienteDetalleWorkspace clienteId={id} abrirInicial={abrirInicial} />
    </section>
  );
}
