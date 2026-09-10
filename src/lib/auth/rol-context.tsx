"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Rol } from "@/lib/auth/auth";

/**
 * Rol del usuario autenticado, provisto UNA vez desde el layout de servidor.
 * Reemplaza los `fetch("/api/auth/get-session")` que cada componente hacía
 * (y que arrancaban asumiendo OPERATIVO hasta que respondía la red).
 */
const RolContext = createContext<Rol | null>(null);

export function RolProvider({ rol, children }: { rol: Rol; children: ReactNode }) {
  return <RolContext.Provider value={rol}>{children}</RolContext.Provider>;
}

/** Rol actual. Fuera del provider (páginas públicas, tests) cae a OPERATIVO. */
export function useRol(): Rol {
  return useContext(RolContext) ?? "OPERATIVO";
}

/** `true` si el rol actual está en la lista. */
export function usePermiso(roles: readonly Rol[]): boolean {
  const rol = useRol();
  return roles.includes(rol);
}

export function useEsAdmin(): boolean {
  return useRol() === "ADMIN";
}
