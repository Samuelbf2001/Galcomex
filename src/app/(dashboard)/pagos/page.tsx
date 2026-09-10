import { PagosWorkspace } from "@/components/pagos/pagos-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function PagosPage() {
  await exigirAccesoPagina("/pagos");
  return <PagosWorkspace />;
}
