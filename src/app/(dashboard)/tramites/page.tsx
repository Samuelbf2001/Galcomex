import { TramitesWorkspace } from "@/components/tramites/tramites-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function TramitesPage() {
  await exigirAccesoPagina("/tramites");
  return <TramitesWorkspace />;
}
