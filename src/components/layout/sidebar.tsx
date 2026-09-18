"use client";

import {
  Banknote,
  BriefcaseBusiness,
  ClipboardList,
  FileCheck2,
  FolderOpen,
  Gauge,
  Handshake,
  Layers,
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
import { useEffect, useRef } from "react";

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
  "/archivos": FolderOpen,
  "/clientes": Users,
  "/configuracion": Settings,
  "/configuracion/catalogos": Layers,
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

  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    function sync() {
      if (!dialog) return;
      if (desktop.matches) {
        if (dialog.open) dialog.close();
        if (abierto) onCerrar?.();
      } else if (abierto && !dialog.open) dialog.showModal();
      else if (!abierto && dialog.open) dialog.close();
    }
    sync();
    desktop.addEventListener("change", sync);
    return () => desktop.removeEventListener("change", sync);
  }, [abierto, onCerrar]);

  const groups = [
    { title: "Vista general", paths: ["/dashboard"] },
    { title: "Operación", paths: ["/tramites", "/anticipos", "/pagos", "/archivos"] },
    { title: "Facturación y cobros", paths: ["/facturacion", "/cartera", "/ingresos", "/liquidacion-lm"] },
    { title: "Administración", paths: ["/clientes", "/configuracion", "/configuracion/catalogos", "/configuracion/importar"] },
  ];

  function content(mobile: boolean) {
    return <>
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-800 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400 text-slate-950"><BriefcaseBusiness className="h-5 w-5" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold leading-5">Galcomex</p><p className="text-xs text-slate-400">Operación interna</p></div>
        {mobile ? <button type="button" onClick={onCerrar} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800" aria-label="Cerrar menú"><X className="h-5 w-5" aria-hidden="true" /></button> : null}
      </div>
      <nav aria-label="Secciones" className="flex-1 space-y-5 overflow-y-auto px-3 py-5">
        {groups.map((group) => {
          const visible = group.paths.flatMap((path) => items.filter((item) => item.href === path));
          if (!visible.length) return null;
          return <div key={group.title}>
            <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group.title}</p>
            <div className="space-y-1">{visible.map((item) => {
              const Icon = ICONOS[item.href] ?? Ship;
              const esActiva = item.href === activa;
              return <Link key={item.href} href={item.href} onClick={onCerrar} aria-current={esActiva ? "page" : undefined} className={"flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition " + (esActiva ? "bg-cyan-500/15 text-white shadow-[inset_3px_0_0_0_#22d3ee]" : "text-slate-300 hover:bg-slate-900 hover:text-white")}>
                <Icon className={"h-4 w-4 shrink-0 " + (esActiva ? "text-cyan-300" : "")} aria-hidden="true" />{item.label}
              </Link>;
            })}</div>
          </div>;
        })}
      </nav>
      <div className="shrink-0 border-t border-slate-800 px-5 py-4 text-xs text-slate-400">Perfil: <span className="font-semibold text-slate-200">{NOMBRE_ROL[rol]}</span></div>
    </>;
  }

  return <>
    <aside aria-label="Menú principal" className="hidden h-full w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-100 lg:flex">{content(false)}</aside>
    <dialog ref={dialogRef} id="mobile-navigation" aria-label="Menú principal"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onCancel={(event) => { event.preventDefault(); onCerrar?.(); }} onClick={(event) => { if (event.target === dialogRef.current) onCerrar?.(); }} className="fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-72 max-w-[85vw] border-0 bg-slate-950 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/50 lg:hidden">
      <div className="flex h-full flex-col">{content(true)}</div>
    </dialog>
  </>;
}
