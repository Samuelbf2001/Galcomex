"use client";

import { KeyRound, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { FranjaRolSimulado } from "@/components/layout/franja-rol-simulado";
import { LogoutButton } from "@/components/layout/logout-button";
import { SelectorRolSimulado } from "@/components/layout/selector-rol-simulado";
import { Sidebar } from "@/components/layout/sidebar";
import type { Rol } from "@/lib/auth/auth";
import type { RolSimulable } from "@/lib/auth/rol-simulado";
import { rutaDashboardDe } from "@/lib/auth/rutas-roles";

type AppShellProps = {
  /** Rol EFECTIVO: el que ven el menú y las páginas (el probado, si lo hay). */
  rol: Rol;
  /** Rol REAL del usuario: decide si se muestra «Probar como…» (solo ADMIN). */
  rolReal: Rol;
  /** Rol que la administradora está probando, o null. */
  rolSimulado: RolSimulable | null;
  nombre: string;
  email: string;
  children: ReactNode;
};

/**
 * Cascarón del dashboard: sidebar (fijo en escritorio, panel en móvil),
 * cabecera con usuario y contenido con scroll propio. Con «Probar como otro
 * rol» activo, una franja ámbar ocupa la parte de arriba de todo.
 */
export function AppShell({ rol, rolReal, rolSimulado, nombre, email, children }: AppShellProps) {
  const [menuAbierto, setMenuAbierto] = useState(false);
  const pathname = usePathname();
  const modulo = rutaDashboardDe(pathname);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-slate-100 text-slate-950">
      <a href="#contenido-principal" className="sr-only z-50 rounded-lg bg-white p-3 text-slate-900 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Saltar al contenido</a>
      {rolSimulado ? <FranjaRolSimulado rolSimulado={rolSimulado} /> : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
            {rolReal === "ADMIN" ? <SelectorRolSimulado rolSimulado={rolSimulado} /> : null}
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
    </div>
  );
}
