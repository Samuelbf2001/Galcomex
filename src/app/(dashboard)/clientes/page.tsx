import { ClientesWorkspace } from "@/components/clientes/clientes-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function ClientesPage() {
  await exigirAccesoPagina("/clientes");
  return <ClientesWorkspace />;
}
