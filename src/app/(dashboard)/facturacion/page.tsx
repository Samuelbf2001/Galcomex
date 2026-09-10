import { FacturacionWorkspace } from "@/components/facturacion/facturacion-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function FacturacionPage() {
  await exigirAccesoPagina("/facturacion");
  return <FacturacionWorkspace />;
}
