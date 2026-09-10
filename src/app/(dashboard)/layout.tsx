import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { Rol } from "@/lib/auth/auth";
import { RolProvider } from "@/lib/auth/rol-context";
import { getCurrentSession } from "@/lib/auth/session";

/**
 * Layout del dashboard. La sesión se resuelve una vez (React.cache) y el rol
 * baja por contexto a todos los componentes cliente; ninguno vuelve a pedirla
 * por fetch. El acceso por rol a cada módulo lo aplica `exigirAccesoPagina`
 * en cada page.tsx.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/auth/login");
  }

  const rol = session.user.rol as Rol;

  return (
    <RolProvider rol={rol}>
      <ToastProvider>
        <ConfirmProvider>
          <AppShell rol={rol} nombre={session.user.name} email={session.user.email}>
            {children}
          </AppShell>
        </ConfirmProvider>
      </ToastProvider>
    </RolProvider>
  );
}
