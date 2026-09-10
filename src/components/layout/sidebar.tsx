"use client";

import {
  Banknote,
  BriefcaseBusiness,
  ClipboardList,
  FileCheck2,
  Gauge,
  Handshake,
  Receipt,
  Settings,
  Ship,
  TrendingUp,
  UploadCloud,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { Rol } from "@/lib/auth/auth";
import { rutaDashboardDe, rutasVisiblesPara } from "@/lib/auth/rutas-roles";

const ICONOS: Record<string, LucideIcon> = {
  "/dashboard": Gauge,
  "/tramites": Ship,
  "/facturacion": FileCheck2,
  "/cartera": Banknote,
  "/liquidacion-lm": Handshake,
  "/anticipos": ClipboardList,
  "/ingresos": TrendingUp,
  "/pagos": Receipt,
  "/clientes": Users,
  "/configuracion": Settings,
  "/configuracion/importar": UploadCloud,
};

const NOMBRE_ROL: Record<Rol, string> = {
  ADMIN: "Administración",
  REVISOR: "Revisión",
  OPERATIVO: "Operativo",
  SOCIO: "Socio",
};

type SidebarProps = {
  rol: Rol;
  /** En pantallas pequeñas el sidebar es un panel deslizante. */
  abierto?: boolean;
  onCerrar?: () => void;
};

/**
 * Menú lateral. Los ítems salen del mismo mapa que usa el guard de página
 * (`RUTAS_DASHBOARD`), marca el módulo activo con `aria-current` y en
 * pantallas < 1024 px se convierte en un panel que se abre desde la cabecera.
 */
export function Sidebar({ rol, abierto = false, onCerrar }: SidebarProps) {
  const pathname = usePathname();
  const activa = rutaDashboardDe(pathname)?.href;
  const items = rutasVisiblesPara(rol);

  return (
    <>
      {abierto ? (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={onCerrar}
          className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 -translate-x-full flex-col border-r border-slate-800 bg-slate-950 text-slate-100 transition-transform lg:static lg:translate-x-0 ${abierto ? "translate-x-0" : ""}`}
        aria-label="Menú principal"
      >
        <div className="flex h-16 items-center gap-3 border-b border-slate-800 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-500 text-slate-950">
            <BriefcaseBusiness className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-5">Galcomex</p>
            <p className="text-xs text-slate-400">Operación interna</p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-white lg:hidden"
            aria-label="Cerrar menú"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
          {items.map((item) => {
            const Icon = ICONOS[item.href] ?? Ship;
            const esActiva = item.href === activa;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onCerrar}
                aria-current={esActiva ? "page" : undefined}
                className={`flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition ${
                  esActiva
                    ? "bg-cyan-500/15 text-white shadow-[inset_3px_0_0_0_#22d3ee]"
                    : "text-slate-300 hover:bg-slate-900 hover:text-white"
                }`}
              >
                <Icon className={`h-4 w-4 ${esActiva ? "text-cyan-300" : ""}`} aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-400">
          Perfil: <span className="font-semibold text-slate-200">{NOMBRE_ROL[rol]}</span>
        </div>
      </aside>
    </>
  );
}
