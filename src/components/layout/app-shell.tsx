"use client";

import { KeyRound, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { LogoutButton } from "@/components/layout/logout-button";
import { Sidebar } from "@/components/layout/sidebar";
import type { Rol } from "@/lib/auth/auth";
import { rutaDashboardDe } from "@/lib/auth/rutas-roles";

type AppShellProps = {
  rol: Rol;
  nombre: string;
  email: string;
  children: ReactNode;
};

/**
 * Cascarón del dashboard: sidebar (fijo en escritorio, panel en móvil),
 * cabecera con usuario y contenido con scroll propio.
 */
export function AppShell({ rol, nombre, email, children }: AppShellProps) {
  const [menuAbierto, setMenuAbierto] = useState(false);
  const pathname = usePathname();
  const modulo = rutaDashboardDe(pathname);

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-slate-100 text-slate-950">
      <a href="#contenido-principal" className="sr-only z-50 rounded-lg bg-white p-3 text-slate-900 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Saltar al contenido</a>
      <Sidebar rol={rol} abierto={menuAbierto} onCerrar={() => setMenuAbierto(false)} />
      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMenuAbierto(true)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 transition hover:bg-slate-100 lg:hidden"
              aria-label="Abrir menú"
              aria-expanded={menuAbierto}
              aria-controls="mobile-navigation"
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{modulo?.label ?? (pathname === "/cambiar-password" ? "Cambiar contraseña" : "Galcomex")}</p>
              <p className="truncate text-xs text-slate-500" title={email}>{nombre}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/cambiar-password"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 text-slate-600 transition hover:bg-slate-100"
              title="Cambiar contraseña"
              aria-label="Cambiar contraseña"
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
            </Link>
            <LogoutButton />
          </div>
        </header>
        <main id="contenido-principal" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
    </div>
  );
}
