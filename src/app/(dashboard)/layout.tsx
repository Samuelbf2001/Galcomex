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
    <div className="min-h-dvh bg-slate-100 text-slate-950">
      <div className="flex min-h-dvh">
        <Sidebar rol={session.user.rol as Rol} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
            <div>
              <p className="text-sm font-semibold">{session.user.name}</p>
              <p className="text-xs text-slate-500">{session.user.email}</p>
            </div>
            <LogoutButton />
          </header>
          <main className="flex-1 px-6 py-5">{children}</main>
        </div>
      </div>
    </div>
  );
}
