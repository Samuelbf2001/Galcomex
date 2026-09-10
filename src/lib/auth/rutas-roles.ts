import type { Rol } from "@/lib/auth/auth";

/**
 * Fuente de verdad ÚNICA de qué rol puede abrir qué módulo del dashboard.
 * La usan: el sidebar (qué ítems pintar), el guard de página
 * (`exigirAccesoPagina`) y la redirección inicial tras el login.
 *
 * Regla: si un rol no está aquí para una ruta, no debe verla ni por URL.
 */
export type RutaDashboard = {
  href: string;
  label: string;
  roles: readonly Rol[];
};

const TODOS: readonly Rol[] = ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"];

export const RUTAS_DASHBOARD: readonly RutaDashboard[] = [
  { href: "/dashboard", label: "Dashboard", roles: ["ADMIN", "REVISOR", "OPERATIVO"] },
  { href: "/tramites", label: "Trámites", roles: TODOS },
  { href: "/facturacion", label: "Facturación", roles: ["ADMIN", "REVISOR"] },
  { href: "/cartera", label: "Cartera", roles: ["ADMIN", "REVISOR"] },
  { href: "/liquidacion-lm", label: "Liquidación LM", roles: ["ADMIN", "REVISOR"] },
  { href: "/anticipos", label: "Anticipos", roles: ["ADMIN", "OPERATIVO"] },
  { href: "/ingresos", label: "Ingresos", roles: ["ADMIN", "REVISOR"] },
  { href: "/pagos", label: "Pagos a proveedores", roles: ["ADMIN", "REVISOR", "OPERATIVO"] },
  { href: "/clientes", label: "Clientes", roles: ["ADMIN", "REVISOR", "OPERATIVO"] },
  { href: "/configuracion", label: "Configuración", roles: ["ADMIN"] },
  { href: "/configuracion/importar", label: "Importar Excel", roles: ["ADMIN"] },
];

/** Rutas del dashboard abiertas a cualquier usuario autenticado. */
export const RUTAS_LIBRES: readonly string[] = ["/cambiar-password", "/sin-acceso"];

/** Prefijos protegidos que el middleware debe interceptar sin cookie. */
export const PREFIJOS_PROTEGIDOS: readonly string[] = [
  ...new Set([
    ...RUTAS_DASHBOARD.map((r) => r.href.split("/").slice(0, 2).join("/")),
    ...RUTAS_LIBRES,
  ]),
];

function coincide(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Devuelve la entrada de RUTAS_DASHBOARD más específica que cubre el pathname. */
export function rutaDashboardDe(pathname: string): RutaDashboard | null {
  let mejor: RutaDashboard | null = null;
  for (const ruta of RUTAS_DASHBOARD) {
    if (coincide(pathname, ruta.href) && (!mejor || ruta.href.length > mejor.href.length)) {
      mejor = ruta;
    }
  }
  return mejor;
}

/**
 * ¿Puede este rol abrir este pathname?
 * - Rutas del mapa: según sus roles (prefijo más largo gana).
 * - Rutas libres: sí.
 * - Rutas desconocidas: sí (las resuelve not-found).
 */
export function rutaPermitida(pathname: string, rol: Rol): boolean {
  if (RUTAS_LIBRES.some((r) => coincide(pathname, r))) return true;
  const ruta = rutaDashboardDe(pathname);
  return ruta ? ruta.roles.includes(rol) : true;
}

/** Primera pantalla útil para cada rol tras iniciar sesión. */
export function rutaInicial(rol: Rol): string {
  return rol === "SOCIO" ? "/tramites" : "/dashboard";
}

/** Ítems del sidebar para un rol, en el orden canónico. */
export function rutasVisiblesPara(rol: Rol): RutaDashboard[] {
  return RUTAS_DASHBOARD.filter((r) => r.roles.includes(rol));
}

/**
 * Valida un destino `?next=` para evitar redirecciones abiertas:
 * solo rutas internas absolutas, sin protocolo ni host, y nunca de vuelta al login.
 */
export function destinoInternoSeguro(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (next.startsWith("/auth/") || next.startsWith("/api/")) return null;
  return next;
}
