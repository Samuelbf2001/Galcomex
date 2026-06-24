import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/layout/logout-button";
import { Sidebar } from "@/components/layout/sidebar";
import type { Rol } from "@/lib/auth/auth";
import { getCurrentSession } from "@/lib/auth/session";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/auth/login");
  }

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-slate-100 text-slate-950">
      <Sidebar rol={session.user.rol as Rol} />
      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div>
            <p className="text-sm font-semibold">{session.user.name}</p>
            <p className="text-xs text-slate-500">{session.user.email}</p>
          </div>
          <LogoutButton />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</main>
      </div>
    </div>
  );
}
