"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

/**
 * Guarda en la dirección (URL) el estado de un listado — página, tamaño de
 * página, filtros — para que al abrir un DO y volver con «atrás» la lista
 * siga en la misma página y con los mismos filtros, y para poder compartir
 * el enlace. Se escribe con `history.replaceState`: no recarga, no pide nada
 * al servidor y no llena el historial (atrás vuelve a la pantalla anterior).
 */
export function escribirParametrosUrl(cambios: Record<string, string | null>) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [nombre, valor] of Object.entries(cambios)) {
    if (valor === null || valor === "") params.delete(nombre);
    else params.set(nombre, valor);
  }
  const qs = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
}

/**
 * Un valor de texto que vive en la URL (`?nombre=valor`). El valor por
 * defecto no se escribe, para que la dirección quede limpia. Con `nombre`
 * null se comporta como un `useState` normal (sin URL).
 *
 * La URL se lee solo al montar: es la memoria para volver, no la fuente de
 * verdad mientras la pantalla está abierta.
 */
export function useParametroUrl(nombre: string | null, porDefecto: string): [string, (valor: string) => void] {
  const searchParams = useSearchParams();
  const [valor, setValor] = useState(() => {
    if (!nombre) return porDefecto;
    // Manda la dirección de la pantalla que se está montando según el router
    // de Next (al navegar de /pagos?pagina=3 a /anticipos, `window.location`
    // todavía dice /pagos durante el render; `useSearchParams` ya dice
    // /anticipos). Next sincroniza `replaceState` con `useSearchParams`, así
    // que al volver con «atrás» trae la página guardada. Fuera del router
    // (pruebas) se lee `window.location`.
    const leido = searchParams
      ? searchParams.get(nombre)
      : typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get(nombre)
        : null;
    return leido ?? porDefecto;
  });
  const fijar = useCallback(
    (nuevo: string) => {
      setValor(nuevo);
      if (nombre) escribirParametrosUrl({ [nombre]: nuevo === porDefecto ? null : nuevo });
    },
    [nombre, porDefecto],
  );
  return [valor, fijar];
}

/** Igual que `useParametroUrl`, para números enteros positivos (página, tamaño). */
export function useNumeroUrl(nombre: string | null, porDefecto: number): [number, (valor: number) => void] {
  const [texto, fijarTexto] = useParametroUrl(nombre, String(porDefecto));
  const numero = Number.parseInt(texto, 10);
  const valor = Number.isFinite(numero) && numero > 0 ? numero : porDefecto;
  const fijar = useCallback((nuevo: number) => fijarTexto(String(nuevo)), [fijarTexto]);
  return [valor, fijar];
}
