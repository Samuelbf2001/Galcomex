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
} from "lucide-react";
import Link from "next/link";

import type { Rol } from "@/lib/auth/auth";

const navItems = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: Gauge,
    roles: ["ADMIN", "REVISOR", "OPERATIVO"] satisfies Rol[],
  },
  {
    href: "/tramites",
    label: "Tramites",
    icon: Ship,
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] satisfies Rol[],
  },
  {
    href: "/facturacion",
    label: "Facturacion",
    icon: FileCheck2,
    roles: ["ADMIN", "REVISOR"] satisfies Rol[],
  },
  {
    href: "/cartera",
    label: "Cartera",
    icon: Banknote,
    roles: ["ADMIN", "REVISOR"] satisfies Rol[],
  },
  {
    href: "/liquidacion-lm",
    label: "Liquidacion LM",
    icon: Handshake,
    roles: ["ADMIN", "REVISOR"] satisfies Rol[],
  },
  {
    href: "/anticipos",
    label: "Anticipos",
    icon: ClipboardList,
    roles: ["ADMIN", "OPERATIVO"] satisfies Rol[],
  },
  {
    href: "/ingresos",
    label: "Ingresos",
    icon: TrendingUp,
    roles: ["ADMIN", "REVISOR"] satisfies Rol[],
  },
  {
    href: "/pagos",
    label: "Pagos a proveedores",
    icon: Receipt,
    roles: ["ADMIN", "REVISOR", "OPERATIVO"] satisfies Rol[],
  },
  {
    href: "/clientes",
    label: "Clientes",
    icon: Users,
    roles: ["ADMIN", "REVISOR", "OPERATIVO"] satisfies Rol[],
  },
  {
    href: "/configuracion",
    label: "Configuracion",
    icon: Settings,
    roles: ["ADMIN"] satisfies Rol[],
  },
  {
    href: "/configuracion/importar",
    label: "Importar Excel",
    icon: UploadCloud,
    roles: ["ADMIN"] satisfies Rol[],
  },
];

type SidebarProps = {
  rol: Rol;
};

export function Sidebar({ rol }: SidebarProps) {
  const visibleItems = navItems.filter((item) => item.roles.includes(rol));

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-950 text-slate-100">
      <div className="flex h-16 items-center gap-3 border-b border-slate-800 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-500 text-slate-950">
          <BriefcaseBusiness className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-5">Galcomex</p>
          <p className="text-xs text-slate-400">Operacion interna</p>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
        {visibleItems.map((item) => {
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-slate-300 transition hover:bg-slate-900 hover:text-white"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-400">
        Rol activo: <span className="font-semibold text-slate-200">{rol}</span>
      </div>
    </aside>
  );
}
