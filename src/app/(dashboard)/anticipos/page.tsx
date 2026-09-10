import { AnticiposWorkspace } from "@/components/anticipos/anticipos-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function AnticiposPage() {
  await exigirAccesoPagina("/anticipos");
  return <AnticiposWorkspace />;
}
