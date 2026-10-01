"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Preferencia "menú lateral contraído" (solo íconos), guardada en este
 * navegador. Sirve para ganar ~190 px en las tablas anchas (libro de pagos,
 * cartera, trámites). En el servidor y sin almacenamiento disponible el menú
 * sale expandido, como siempre.
 */
const CLAVE = "galcomex:menu-contraido";
const oyentes = new Set<() => void>();

function leer(): boolean {
  try {
    return window.localStorage.getItem(CLAVE) === "1";
  } catch {
    return false;
  }
}

function suscribir(avisar: () => void): () => void {
  oyentes.add(avisar);
  window.addEventListener("storage", avisar);
  return () => {
    oyentes.delete(avisar);
    window.removeEventListener("storage", avisar);
  };
}

export function useMenuContraido(): [boolean, () => void] {
  const contraido = useSyncExternalStore(suscribir, leer, () => false);
  const alternar = useCallback(() => {
    try {
      window.localStorage.setItem(CLAVE, leer() ? "0" : "1");
    } catch {
      // Sin almacenamiento (modo privado): la preferencia no se recuerda.
    }
    oyentes.forEach((avisar) => avisar());
  }, []);
  return [contraido, alternar];
}
