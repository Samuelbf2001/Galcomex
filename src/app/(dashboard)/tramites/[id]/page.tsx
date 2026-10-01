import { TramiteDetalle } from "@/components/tramites/tramite-detalle";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function TramiteDetallePage({ params }: Props) {
  const { id } = await params;
  await exigirAccesoPagina(`/tramites/${id}`);

  // La cabecera (número del DO, estado y cliente) la pinta TramiteDetalle,
  // que es quien tiene los datos del trámite.
  return (
    <section>
      <TramiteDetalle tramiteId={id} />
    </section>
  );
}
