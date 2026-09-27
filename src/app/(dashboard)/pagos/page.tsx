import { PagosWorkspace } from "@/components/pagos/pagos-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

type SearchParams = Promise<{
  /** Deep-link desde la ficha de una empresa proveedora (§D.5, CxP v2). */
  proveedorEmpresaId?: string;
  /** Deep-link desde una ficha de pago suelta (sin empresa). */
  beneficiarioId?: string;
}>;

export default async function PagosPage({ searchParams }: { searchParams: SearchParams }) {
  await exigirAccesoPagina("/pagos");

  const { proveedorEmpresaId, beneficiarioId } = await searchParams;
  const proveedorInicial = proveedorEmpresaId
    ? { tipo: "EMPRESA" as const, id: proveedorEmpresaId }
    : beneficiarioId
      ? { tipo: "FICHA" as const, id: beneficiarioId }
      : null;

  return <PagosWorkspace proveedorInicial={proveedorInicial} />;
}
