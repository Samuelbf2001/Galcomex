"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { useRol } from "@/lib/auth/rol-context";
import { rutaPermitida } from "@/lib/auth/rutas-roles";
import { cn } from "@/lib/utils";

/**
 * Enlaces a la ficha de cada entidad. Regla de la app: cada vez que se nombra
 * un trámite (DO), una empresa o una factura, el nombre lleva a su detalle.
 *
 * - Si el rol no puede abrir el destino (p. ej. SOCIO → /clientes), se pinta
 *   el texto sin enlace para no mandarlo a "Sin acceso".
 * - `stopPropagation` evita que el clic dispare el onClick de la fila que lo
 *   contiene (tablas con filas clicables o que abren un modal).
 */

/** Pestañas del detalle del trámite que aceptan `?tab=`. */
export type TabTramite =
  | "hoja"
  | "resumen"
  | "documentos"
  | "pagos"
  | "facturas-proveedor"
  | "facturacion"
  | "historial";

export function rutaTramite(id: string, tab?: TabTramite): string {
  return tab ? `/tramites/${id}?tab=${tab}` : `/tramites/${id}`;
}

export function rutaCliente(id: string): string {
  return `/clientes/${id}`;
}

/** Abre el revisor de la factura de venta (borrador) en Facturación. */
export function rutaFacturaVenta(tramiteId: string, borradorId?: string | null): string {
  const params = new URLSearchParams({ tramiteId });
  if (borradorId) params.set("borrador", borradorId);
  return `/facturacion?${params.toString()}`;
}

const ESTILO_ENLACE =
  "text-cyan-700 underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none";

function detener(event: MouseEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

type BaseProps = {
  children: ReactNode;
  className?: string;
  title?: string;
};

function EnlaceSiPermitido({
  href,
  children,
  className,
  title,
}: BaseProps & { href: string }) {
  const rol = useRol();
  const pathname = href.split("?")[0] ?? href;
  if (!rutaPermitida(pathname, rol)) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link href={href} onClick={detener} className={cn(ESTILO_ENLACE, className)} title={title}>
      {children}
    </Link>
  );
}

/** Nombre/consecutivo de un DO → /tramites/[id] (opcionalmente en una pestaña). */
export function EnlaceTramite({
  id,
  tab,
  children,
  className,
  title,
}: BaseProps & { id: string | null | undefined; tab?: TabTramite }) {
  if (!id) return <span className={className}>{children}</span>;
  return (
    <EnlaceSiPermitido
      href={rutaTramite(id, tab)}
      className={className}
      title={title ?? "Ver trámite"}
    >
      {children}
    </EnlaceSiPermitido>
  );
}

/** Nombre de una empresa (cliente/proveedor) → /clientes/[id]. */
export function EnlaceCliente({
  id,
  children,
  className,
  title,
}: BaseProps & { id: string | null | undefined }) {
  if (!id) return <span className={className}>{children}</span>;
  return (
    <EnlaceSiPermitido
      href={rutaCliente(id)}
      className={className}
      title={title ?? "Ver empresa"}
    >
      {children}
    </EnlaceSiPermitido>
  );
}

/**
 * Número de una factura de venta (BAQ-XXXXX) o borrador → revisor en
 * Facturación. Si el rol no entra a Facturación (OPERATIVO, SOCIO), cae a la
 * pestaña "Facturas de venta" del trámite.
 */
export function EnlaceFacturaVenta({
  tramiteId,
  borradorId,
  children,
  className,
  title,
}: BaseProps & { tramiteId: string | null | undefined; borradorId?: string | null }) {
  const rol = useRol();
  if (!tramiteId) return <span className={className}>{children}</span>;
  const href = rutaPermitida("/facturacion", rol)
    ? rutaFacturaVenta(tramiteId, borradorId)
    : rutaTramite(tramiteId, "facturacion");
  return (
    <EnlaceSiPermitido href={href} className={className} title={title ?? "Ver factura"}>
      {children}
    </EnlaceSiPermitido>
  );
}
