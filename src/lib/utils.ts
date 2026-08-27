import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combina clases condicionales (clsx) y resuelve conflictos de Tailwind (twMerge). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
