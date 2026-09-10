import { DashboardWorkspace } from "@/components/dashboard/dashboard-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function DashboardPage() {
  await exigirAccesoPagina("/dashboard");
  return <DashboardWorkspace />;
}
