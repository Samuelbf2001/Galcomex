/**
 * Motivo con el que el ADMIN fuerza un DO a Facturado sin factura emitida
 * (ver `factura-emitida.ts`). Sin imports de Prisma: lo usan el servidor y la
 * pantalla.
 */

/** Largo mínimo del motivo (sin espacios de borde). */
export const MOTIVO_FORZAR_MIN = 10;

/** El motivo limpio, o `null` si no alcanza para forzar. */
export function motivoValido(motivo: string | null | undefined): string | null {
  const limpio = motivo?.trim() ?? "";
  return limpio.length >= MOTIVO_FORZAR_MIN ? limpio : null;
}
